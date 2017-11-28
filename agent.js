/* global exports */
const os = require('os');
const jssgf = require('jssgf');
const { move2coord, GtpClient } = require('gtp-wrapper');
const { primaryLastNode } = require('./util.js');
const { didGreet, isIn } = require('./helpers.js');
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
    constructor(ddp, screenName, gtpName) {
        this.ddp = ddp;
        this.screenName = screenName;
        this.gtpName = gtpName;
        this.roomId = null;
        this.state = AgentState.initialState();
        this.size = 19;
        this.color = null;
        this.num = 0;
        this.byoyomi = process.env.NODE_ENV === 'production' ? 15 : 1;
        this.gtp = null;
        this.roomsCursorOptions = { fields: {
            black: 1,
            white: 1,
            game: 1,
            mates: 1,
            greet: 1
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
    }

    start() {
        this.selfObserver = this.ddp.observe('users', undefined, this.userChanged);
        this.selfSubscriptionId = this.ddp.subscribe('users', [{ 'twitter.profile.screen_name': this.screenName }], async () => {
            const ids = Object.keys(this.ddp.collections['users']);
            if (ids.length !== 1) {
                console.log('user selector is wrong.');
            }
            this.id = ids[0];
            await this.ddp.call('setUserId', [this.id]);
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
        await this.stopGtp();
        this.stopObserveRooms();
        this.stopObserveRoom();
        if (this.selfObserver) {
            this.selfObserver.stop();
        }
        this.ddp.unsubscribe(this.selfSubscriptionId);
    }

    async enterRoom(id) {
        if (this.state !== this.state.LOBBY) {
            console.log('already playing other game', this.roomId, id);
            return false;
        }
        if (await this.ddp.call('room.enter', [id, true])) {
            this.roomId = id;
            const room = this.ddp.collections.rooms[this.roomId];
            this.color = room.black === this.id ? 'B' : 'W';
            chat.enableChat(this.roomId);
            this.stopObserveRooms();
            this.observeRoom(this.roomId);
            return true;
        } else {
            return false;
        }
    }

    async exitRoom() {
        console.log('exitRoom');
        await this.stopObserveRoom();
        chat.disableChat(this.roomId);
        await this.ddp.call('room.exit', [this.roomId, true]);
        this.roomId = null;
        this.observeRooms();
        return true;
    }

    async startGtp(sgf) {
        console.log('startGtp');
        this.gtp = new GtpClient();

        const options = [];
        /*
        // サンプルとしてLeela固有コード
        const [root] = jssgf.fastParse(sgf);

        if (root.RU === 'Japanese' || root.KM === '6.5') {
            options.push('--komiadjust');
        }
        */

        await this.gtp.loadSgf(sgf, options);
        await this.gtp.timeSettings(0, this.byoyomi, 1);
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
        return move2coord(move, this.size);
    }

    async opponentPlay(root, node) {
        const coord = this.opponentMove(root, node);
        if (coord) {
            await this.gtp.play(coord);
        }
    }

    async stopGtp() {
        if (this.gtp) {
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
                    switch (e.signal) {
                        case 'SIGSEGV':
                        console.log(e);
                        await this.startGtp(sgf);
                        break;
                        default:
                        throw e;
                    }
                }
            }
        } while (data == null);
        return data;
    }

    async changed(id, oldFields, clearedFields, newFields) {
        await this.state.changed(this, this.ddp.collections.rooms[id], oldFields, clearedFields, newFields);
    }

    setState(state) {
        this.state = state;
        this.state.entry(this).catch(function(reason) {
            console.log(reason);
        });
    }

    setStateFromRoom(room) {
        console.log('setStateFromRoom');
        if (room.black === this.id) {
            this.color = 'B';
            this.opponentId = room.white;
        } else {
            this.color = 'W';
            this.opponentId = room.black;
        }
        if (!didGreet(room, this.id, 'start')) {
            if (isIn(room, this.opponentId)) {
                this.setState(this.state.START_GREETING);
            } else {
                // 相手が要る時に部屋に入る仕様なのでここはコールされないはず。NOT_GREET状態要らないか
                this.setState(this.state.NOT_GREET);
            }
        } else if (room.counting) {
            this.setState(this.state.COUNTING);
        } else if (room.result) {
            if (didGreet(room, this.id, 'end')) {
                console.log('should not reached'); // 挨拶した部屋には入らない
            } else {
                this.setState(this.state.STOP);
            }
        } else {
            const [root] = jssgf.fastParse(room.game);
            const { num, node } = primaryLastNode(root);
            if (num === 0) {
                const whiteSen = root.HA && parseInt(root.HA) >= 2;
                if ((whiteSen && this.color === 'W') || (!whiteSen && this.color === 'B')) { // 手番なら
                    this.setState(this.state.FIRST_MOVE);
                } else {
                    this.setState(this.state.WAITING);
                }
            } else if (node[this.color]) {
                this.setState(this.state.WAITING);
            } else {
                this.setState(this.state.THINKING);
            }
        }
    }

    observeRooms() {
        console.log('observe');
        const handler = (id, oldFields, clearedFields, newFields) => {
            this.changed(id, oldFields, clearedFields, newFields).catch(function (reason) {
                console.log('behave error', reason);
            });
        }
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
        console.log('observe');
        const addedHandler = (id) => {
            const room = this.ddp.collections.rooms[id];
            this.setStateFromRoom(room);
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
}

exports.chat = chat;
exports.Agent = Agent;
