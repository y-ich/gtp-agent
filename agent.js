/* global exports */
const os = require('os');
const jssgf = require('jssgf');
const DDPClient = require('ddp');
const { coord2move, move2coord, GtpClient } = require('gtp-wrapper');
const { sleep } = require('./util.js');
const { didGreet, isIn } = require('./helpers.js');

const CHAT_SERVER = process.env.NODE_ENV === 'production' ?
    'wss://mimiaka-chat.herokuapp.com/websocket' :
    'ws://localhost:5000/websocket';

GtpClient.OPTIONS = ['--gtp', '--threads', Math.min(7, os.cpus().length - 1)];


function primaryLastNode(root) {
    let num = 0;
    let node = root;
    while (node._children.length > 0) {
        node = node._children[0];
        if (node.B || node.W) {
            num += 1;
        }
    }
    return { num, node };
}

const chat = {
    chatServer: null,
    rooms: new Set(),
    enableChat(roomId) {
        if (!this.chatServer) {
            this.chatServer = new DDPClient({ url: CHAT_SERVER });
            this.chatServer.connect();
        }
        this.rooms.add(roomId);
    },

    disableChat(roomId) {
        this.rooms.delete(roomId);
        if (this.rooms.size === 0) {
            this.chatServer.close();
            this.chatServer = null;
        }
    },

    chat(roomId, user, message, lang) {
        if (!this.chatServer) {
            console.log('has not connected with chatServer yet', message);
            return;
        }
        this.chatServer.call('chat', ['twiigo', roomId, null, {
            id: user._id,
            name: user.profile.name,
            lang,
            gender: user.profile.gender
        }, message], function(error) {
            console.log(error);
        });
    }
}

/**
 * ついー碁でプレイするAIエージェント
 */
class Agent {
    static init() {
        this.prototype.ERROR = -1;
        this.prototype.NOT_GREET = 0;
        this.prototype.START_GREETING = 1;
        this.prototype.WAITING = 2;
        this.prototype.THINKING = 3;
        this.prototype.COUNTING = 4;
        this.prototype.STOP = 5;
        this.prototype.END_GREETING = 6;
    }

    /**
     * @param {object} selector - Meteor.usersからプレーヤを選択するセレクタ
     * @param {string} methods - DDPサーバ
     */
    constructor(ddp, screenName, gtpName) {
        this.ddp = ddp;
        this.screenName = screenName;
        this.gtpName = gtpName;
        this.roomId = null;
        this.state = this.NOT_GREET;
        this.size = 19;
        this.color = null;
        this.num = 0;
        this.byoyomi = process.env.NODE_ENV === 'production' ? 15 : 1;
        this.gtp = null;
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
        if (this.roomId) {
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
        await this.stopObserveRoom();
        chat.disableChat(this.roomId);
        await this.ddp.call('room.exit', [this.roomId, true]);
        this.roomId = null;
        this.state = null;
        this.observeRooms();
        return true;
    }

    async startGtp(sgf) {
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

    async play(root, node) {
        let data;
        do {
            try {
                data = await this.gtp.genmove();
            } catch (e) {
                this.gtp = null;
                if (e.message === 'This socket is closed.') {
                    this.state = this.ERROR;
                    throw new Error('no gtp command', 'COMMAND not found');
                } else {
                    if (e.signal === 'SIGINT') { // terminate
                        this.state = this.STOP;
                    } else {
                        console.log('Agent::play', e);
                        this.state = this.ERROR;
                    }
                    throw e;
                }
            }
        } while (data == null);
        switch (data.result) {
            case 'PASS': {
                const next = { _children: [] };
                next[this.color] = '';
                node._children.push(next);
                this.state = this.WAITING;
                break;
            }
            case 'resign':
                root.RE = `${jssgf.opponentOf(this.color)}+R`;
                this.state = this.STOP;
                break;
            default: {
                if (/[A-Z][0-9]{1,2}/.test(data.result)) {
                    const next = { _children: [] };
                    next[this.color] = coord2move(data.result, this.size);
                    node._children.push(next);
                    this.state = this.WAITING;
                } else {
                    console.log('play error', data);
                    this.state = this.ERROR;
                    return null;
                }
            }
        }
        try {
            await this.ddp.call('room.updateGame', [this.roomId, jssgf.stringify([root])]);
        } catch (e) {
            this.state = this.ERROR;
            console.log(e);
        }
        return data;
    }

    async behaveInLobby(id, oldFields, clearedFields, newFields) {
        console.log('behaveInLobby', id);
        const room = this.ddp.collections.rooms[id];
        let opponentId;
        if (room.black === this.id) {
            opponentId = room.white;
        } else {
            opponentId = room.black;
        }

        // 入室
        if (!this.roomId && !isIn(room, this.id) && isIn(room, opponentId)) {
            console.log('enterRoom');
            await this.enterRoom(id);
        }
    }

    async behaveInRoom(id, oldFields, clearedFields, newFields) {
        console.log('behaveInRoom', id);
        const fields = newFields || {};
        const room = this.ddp.collections.rooms[id];
        let opponentId;
        if (room.black === this.id) {
            this.color = 'B';
            opponentId = room.white;
        } else {
            this.color = 'W';
            opponentId = room.black;
        }

        // 挨拶
        if (this.state !== this.START_GREETING &&
            !didGreet(room, this.id, 'start')) { // 挨拶していなければ
            if (isIn(room, opponentId)) { // 相手が部屋に居れば
                this.state = this.START_GREETING;
                await sleep(3000);
                await this.ddp.call('room.greet', [this.roomId, 'start']);
            }
            return;
        }

        if (fields.counting) { // 整地に入ったなら
            await this.stopGtp();
        } else if (room.result) { // 終局したなら
            console.log("behave: end");
            await this.stopGtp();
            if (this.state !== this.END_GREETING &&
                !didGreet(room, this.id, 'end')) { // 挨拶していなければ
                this.state = this.END_GREETING;
                await sleep(3000);
                await this.ddp.call('room.greet', [this.roomId, 'end']);
                await this.exitRoom();
            }
        } else if (!room.counting && !room.result && this.state !== this.THINKING) {
            const [root] = jssgf.fastParse(room.game);
            if (root._children.length === 0) { // 初手なら
                const whiteSen = root.HA && parseInt(root.HA) >= 2;
                if ((whiteSen && this.color === 'W') || (!whiteSen && this.color === 'B')) { // 手番なら
                    this.size = parseInt(root.SZ || '19');
                    await this.startGtp(room.game);
                    this.state = this.THINKING;
                    await sleep(3000);
                    await this.play(root, root);
                } else if (!isIn(room, opponentId)) { // 相手が居なければ
                    console.log("behave: opponent left room before first move");
                    await this.stopGtp();
                    console.log('behave2');
                    await this.exitRoom();
                }
            } else { // 初手じゃなければ
                const { num, node } = primaryLastNode(root);
                this.num = num;
                if (node[this.color]) { // 手番でなければ
                    if (!isIn(room, opponentId)) { // 相手が居なければ
                        console.log("behave: opponent left room on the way");
                        await this.stopGtp();
                        console.log('behave3');
                        await this.exitRoom();
                    }
                } else { // 手番なら
                    if (this.gtp) {
                        await this.opponentPlay(root, node);
                    } else {
                        this.size = parseInt(root.SZ || '19');
                        await this.startGtp(room.game);
                    }
                    console.log('behave play');
                    this.state = this.THINKING;
                    try {
                        await this.play(root, node);
                    } catch (e) {
                        if (this.state === this.ERROR) {
                            console.log('retry playing');
                            this.state = this.THINKING;
                            await this.startGtp(room.game);
                            await this.play(root, node);
                        }
                    }
                }
            }
        }
    }

    observeRooms() {
        console.log('observe');
        const handler = (id, oldFields, clearedFields, newFields) => {
            this.behaveInLobby(id, oldFields, clearedFields, newFields).catch(function (reason) {
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
        const handler = (id, fields) => {
            this.behaveInRoom(id, fields).catch(function (reason) {
                console.log('behave error', reason);
            });
        }
        this.roomObserver = this.ddp.observe('rooms', handler, handler);
        this.roomsSubscriptionId = this.ddp.subscribe('rooms', [{ _id: id }]);
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

Agent.init();

exports.chat = chat;
exports.Agent = Agent;
