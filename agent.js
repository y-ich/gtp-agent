/* global exports */
const os = require('os');
const { execFile } = require('child-process-promise');
const jssgf = require('jssgf');
const { move2coord, GtpClient } = require('gtp-wrapper');
const { chat } = require('./chat.js');
const { AgentState } = require('./agent-state.js');

GtpClient.OPTIONS = ['--gtp', '--threads', Math.min(7, os.cpus().length - 1)];

/**
 * ついー碁でプレイするAIエージェント
 */
class Agent {
    /**
     * @param {object} selector - Meteor.usersからプレーヤを選択するセレクタ
     * @param {string} methods - DDPサーバ
     */
    constructor(ddp, screenName, maxByoyomi = 15, gtpName) {
        this.ddp = ddp;
        this.screenName = screenName;
        this.gtpName = gtpName;
        this.roomId = null;
        this.state = AgentState.initialState();
        this.color = null;
        this.byoyomis = {
            '9': 5,
            '13': 10,
            '19': 15
        };
        this.maxByoyomi = maxByoyomi;
        this.gtp = null;
        this.stoppingGtp = false;
        this.roomsCursorOptions = { fields: {
            black: 1,
            white: 1,
            game: 1,
            mates: 1,
            greet: 1,
            result: 1
        }};
        this.roomCursorOptions = { fields: {
            black: 1,
            white: 1,
            game: 1,
            mates: 1,
            greet: 1,
            counting: 1,
            result: 1
        }};
        this.handleConstants = this.handleConstants.bind(this);
    }

    start() {
        this.constantsObserver = this.ddp.observe('constants', this.handleConstants, this.handleConstants);
        this.constantsSubscriptionId = this.ddp.subscribe('constants', [{ category: process.env.HEROKU_APP_NAME }]);

        this.selfSubscriptionId = this.ddp.subscribe('users', [{ 'twitter.profile.screen_name': this.screenName }], async () => {
            const ids = Object.keys(this.ddp.collections['users']);
            if (ids.length !== 1) {
                console.log('user selector is wrong.');
            }
            this.id = ids[0];
            try {
                await this.ddp.call('setUserId', [this.id]);
            } catch (e) {
                console.log('setUserId', e);
                return;
            }
            this.user = this.ddp.collections['users'][this.id];
            this.roomsSelector = { $or: ['black', 'white'].map(e => this.gtpName ? {
                [e]: this.id,
                [e + 'GtpName']: this.gtpName,
                [`greet.end.${this.id}`]: { $exists: false }
            } : {
                [e]: this.id,
                [`greet.end.${this.id}`]: { $exists: false }
            })};
            this.observeRooms();
        });
    }

    async stop() {
        console.log('stop');
        if (!this.selfSubscriptionId) { // startする前
            return;
        }
        await this.stopGtp();
        await this.exitRoom();
        this.setState(this.state.LOBBY);
        this.stopObserveRooms();
        this.ddp.unsubscribe(this.selfSubscriptionId);
        this.ddp.unsubscribe(this.constantsSubscriptionId);
    }

    async enterRoom(id) {
        if (this.state !== this.state.LOBBY) {
            console.log('already playing other game', this.roomId, id);
            return false;
        }
        this.setState(this.state.ENTERING);
        if (await this.ddp.call('room.enter', [id, true])) {
            this.roomId = id;
            const room = this.getCurrentRoom();
            this.color = room.black === this.id ? 'B' : 'W';
            chat.enableChat(this.roomId);
            this.stopObserveRooms();
            this.observeRoom(this.roomId);
            return true;
        } else {
            this.setState(this.state.LOBBY);
            return false;
        }
    }

    async exitRoom() {
        console.log('exitRoom');
        if (this.id) {
            await this.stopObserveRoom();
            chat.disableChat(this.roomId);
            await this.ddp.call('room.exit', [this.roomId, true]);
            this.roomId = null;
            this.observeRooms();
            return true;
        } else {
            console.log('agent has not start yet.');
            return false;
        }
    }

    async startGtp(sgf) {
        console.log('startGtp');
        this.gtp = new GtpClient();

        const options = [];
        const [root] = jssgf.fastParse(sgf);

        await this.gtp.loadSgf(sgf, options);
        await this.gtp.timeSettings(0, Math.min(this.byoyomis[root.SZ], this.maxByoyomi), 1);
    }

    opponentMove(root, node) {
        let move;
        if (node.B != null) {
            move = node.B;
        } else if (node.W != null) {
            move = node.W;
        } else {
            return null;
        }
        return move2coord(move, this.gtp.size);
    }

    async opponentPlay(root, node) {
        const coord = this.opponentMove(root, node);
        if (coord) {
            await this.gtp.play(coord);
        }
    }

    async stopGtp(restart = true) {
        console.log('stopGtp');
        if (this.gtp) {
            if (!restart) {
                this.stoppingGtp = true;
            }
            await this.gtp.terminate();
            this.gtp = null;
        }
    }

    async play(sgf) {
        let data;
        do {
            try {
                data = await this.gtp.genmove();
            } catch (e) {
                this.gtp = null;
                if (e.message === 'This socket is closed.') {
                    throw new Error('no gtp command', 'COMMAND not found');
                } else {
                    console.log(this.state.getName());
                    console.log(e);
                    switch (e.signal) {
                        case 'SIGINT':
                        if (this.stoppingGtp) { // 意図的なSIGINTなら終了
                            this.stoppingGtp = false;
                            throw e;
                        } else { // 意図的でないSIGINTならリトライ
                            await this.startGtp(sgf);
                        }
                        break;
                        default:
                        await this.startGtp(sgf);
                    }
                }
            }
        } while (data == null);
        return data;
    }

    async changed(id, oldFields, clearedFields, newFields) {
        try {
            await this.state.changed(this, this.getRoom(id), oldFields, clearedFields, newFields);
        } catch (e) {
            console.log('changed error: ', e);
        }
    }

    async setState(state) {
        try {
            await this.state.exit(this);
            this.state = state;
            await this.state.entry(this);
        } catch (e) {
            console.log(e);
        }
    }

    observeRooms() {
        const handler = this.changed.bind(this);
        this.roomsObserver = this.ddp.observe('rooms', handler, handler);
        this.roomsSubscriptionId = this.ddp.subscribe('rooms', [this.roomsSelector, this.roomsCursorOptions]);
    }

    stopObserveRooms() {
        if (this.roomsObserver) {
            this.roomsObserver.stop();
            this.roomsObserver = null;
            this.ddp.unsubscribe(this.roomsSubscriptionId);
        }
    }

    observeRoom(id) {
        console.log('observeRoom');
        const addedHandler = (id) => {
            const room = this.getRoom(id);
            if (room.black === this.id) {
                this.color = 'B';
                this.opponentId = room.white;
            } else {
                this.color = 'W';
                this.opponentId = room.black;
            }
            this.setState(AgentState.fromRoom(this, room));
            this.changed(id).catch(function (reason) {
                console.log('behave error', reason);
            });
        };
        const changedHandler = (id, oldFields, clearedFields, newFields) => {
            this.changed(id, oldFields, clearedFields, newFields).catch(function (reason) {
                console.log('behave error', reason);
            });
        };
        this.roomObserver = this.ddp.observe('rooms', addedHandler, changedHandler);
        this.roomsSubscriptionId = this.ddp.subscribe('rooms', [{ _id: id }, this.roomCursorOptions]);
    }

    async stopObserveRoom() {
        await this.stopGtp();
        if (this.roomObserver) {
            this.roomObserver.stop();
            this.roomObserver = null;
            this.ddp.unsubscribe(this.roomsSubscriptionId);
        }
    }

    getRoom(id) {
        return this.ddp.collections.rooms[id];
    }

    getCurrentRoom() {
        if (this.roomId) {
            return this.getRoom(this.roomId);
        } else {
            return null;
        }
    }

    async handleConstants(id) {
        try {
            const memoryQuotaExceeded = this.ddp.collections.constants[id].memoryQuotaExceeded;
            console.log('handleConstants: %s, %s', id, memoryQuotaExceeded);
            if (memoryQuotaExceeded) {
                const { stdout, stderr } = await execFile('ps', ['xl', '--sort', '-rss']);
                console.log('handleConstants');
                console.log(stdout);
                console.log(stderr);
                await this.stopGtp(true);
                await new Promise((res, rej) => {
                    this.ddp.call('resetMemoryQuotaExceeded', [process.env.HEROKU_APP_NAME], function(e, r) {
                        if (e) {
                            rej(e);
                        } else {
                            res(r);
                        }
                    });
                });
            }
        } catch(e) {
            console.log(e);
        }
    }
}

exports.chat = chat;
exports.Agent = Agent;
