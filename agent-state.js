/* global exports */
const jssgf = require('jssgf');
const { coord2move } = require('gtp-wrapper');
const { sleep, primaryLastNode } = require('./util.js');
const { didGreet, isIn } = require('./helpers.js');


class AgentState {
    static init() {
        this.prototype.ERROR = new ErrorState();
        this.prototype.LOBBY = new LobbyState();
        this.prototype.NOT_GREET = new NotGreetState();
        this.prototype.START_GREETING = new StartGreetingState();
        this.prototype.WAITING = new WaitingState();
        this.prototype.FIRST_MOVE = new FirstMoveState();
        this.prototype.THINKING = new ThinkingState();
        this.prototype.COUNTING = new CountingState();
        this.prototype.STOP = new StopState();
        this.prototype.END_GREETING = new EndGreetingState();
    }

    static initialState() {
        return this.prototype.LOBBY;
    }

    static getFirstPlayState(agent, root) {
        const whiteSen = root.HA && parseInt(root.HA) >= 2;
        if (whiteSen ^ (agent.color === 'B')) { // 手番なら
            return this.prototype.FIRST_MOVE;
        } else {
            return this.prototype.WAITING;
        }
    }

    static fromRoom(agent, room) {
        if (!didGreet(room, agent.id, 'start')) {
            if (isIn(room, agent.opponentId)) {
                return this.prototype.START_GREETING;
            } else {
                // 相手が要る時に部屋に入る仕様なのでここはコールされないはず。NOT_GREET状態要らないか
                return this.prototype.NOT_GREET;
            }
        } else if (room.counting) {
            return this.prototype.COUNTING;
        } else if (room.result) {
            if (didGreet(room, agent.id, 'end')) {
                throw new Error('should-not-reached'); // 終わりの挨拶した部屋には入らない
            } else {
                return this.prototype.STOP;
            }
        } else {
            const [root] = jssgf.fastParse(room.game);
            const { num, node } = primaryLastNode(root);
            if (num === 0) {
                return this.getFirstPlayState(agent, root);
            } else if (node[agent.color]) {
                return this.prototype.WAITING;
            } else {
                return this.prototype.THINKING;
            }
        }
    }

    constructor() {}

    async entry(agent) {
        console.log(this.constructor.name);
    }

    async exit(agent) {}

    async changed(agent, room, oldFields, clearedFields, newFields = {}) {
        if (!isIn(room, agent.opponentId)) {
            await agent.stopGtp();
            await agent.exitRoom();
            agent.setState(this.LOBBY);
        } else if (room.counting) {
            agent.setState(this.COUNTING);
        } else if (room.result) {
            agent.setState(this.END_GREETING);
        }
    }

    async timedOut(agent) {}
}

class LobbyState extends AgentState {
    async changed(agent, room, oldFields, clearedFields, newFields = {}) {
        const opponentId = room.black === agent.id ? room.white : room.black;
        if (!isIn(room, agent.id) && isIn(room, opponentId)) {
            await agent.enterRoom(room._id);
        }
    }
}

class ErrorState extends AgentState {

}

class NotGreetState extends AgentState {
    async changed(agent, room, oldFields, clearedFields, newFields = {}) {
        if (isIn(room, this.opponentId)) { // 相手が部屋に居れば
            agent.setState(this.START_GREETING);
        }
    }
}

class StartGreetingState extends AgentState {
    async entry(agent) {
        super.entry(agent);
        await sleep(3000); // TODO - 0だと何故かチャットしない。
        this.timedOut(agent);
    }

    async timedOut(agent) {
        await agent.ddp.call('room.greet', [agent.roomId, 'start']);
        const room = agent.getCurrentRoom();
        const [root] = jssgf.fastParse(room.game);
        if (root._children.length === 0) { // 初手なら
            agent.setState(this.constructor.getFirstPlayState(agent, root));
        } else {
            agent.setState(this.THINKING);
        }
    }
}

class FirstMoveState extends AgentState {
    async entry(agent) {
        super.entry(agent);
        await sleep(3000);
        this.timedOut(agent);
    }

    async timedOut(agent) {
        agent.setState(this.THINKING);
    }
}

class WaitingState extends AgentState {
    async entry(agent) {
        super.entry(agent);
        if (!agent.gtp) {
            const room = agent.getCurrentRoom();
            await agent.startGtp(room.game);
        }
    }

    async changed(agent, room, oldFields, clearedFields, newFields = {}) {
        if (!isIn(room, agent.opponentId)) {
            await agent.stopGtp();
            await agent.exitRoom();
            agent.setState(this.LOBBY);
        } else if (newFields.counting) {
            agent.setState(this.COUNTING);
        } else if (newFields.result) {
            console.log('pass2');
            agent.setState(this.END_GREETING);
        } else if (newFields.game) {
            if (!agent.gtp) {
                await agent.startGtp(room.game);
            }
            const [root] = jssgf.fastParse(room.game);
            const node = jssgf.nthMoveNode(root, Infinity);
            if (!node[agent.color]) {
                await agent.opponentPlay(root, node);
                agent.setState(this.THINKING);
            }
        }
    }
}

class ThinkingState extends AgentState {
    async entry(agent) {
        super.entry(agent);
        this.next = null;
        const room = agent.getCurrentRoom();
        if (!agent.gtp) {
            await agent.startGtp(room.game);
        }
        const [root] = jssgf.fastParse(room.game);
        const node = jssgf.nthMoveNode(root, Infinity);
        const data = await agent.play(room.game);
        switch (data.result) {
            case 'PASS': {
                const next = { _children: [] };
                next[agent.color] = '';
                node._children.push(next);
                this.next = this.WAITING;
                break;
            }
            case 'resign':
                root.RE = `${jssgf.opponentOf(this.color)}+R`;
                this.next = this.STOP;
                break;
            default: {
                if (/[A-Z][0-9]{1,2}/.test(data.result)) {
                    const next = { _children: [] };
                    next[agent.color] = coord2move(data.result, agent.size);
                    node._children.push(next);
                    this.next = this.WAITING;
                } else {
                    console.log('play error', data);
                    this.next = this.ERROR;
                }
            }
        }
        try {
            await agent.ddp.call('room.updateGame', [agent.roomId, jssgf.stringify([root])]);
        } catch (e) {
            console.log(e);
            agent.setState(this.ERROR);
        }
    }

    async changed(agent, room, oldFields, clearedFields, newFields = {}) {
        if (newFields.counting) {
            agent.setState(this.COUNTING);
        } else if (newFields.result) {
            console.log('pass3');
            this.setState(this.END_GREETING);
        } else if (newFields.game) {
            agent.setState(this.next);
        }
    }
}

class CountingState extends AgentState {

}

class StopState extends AgentState {

}

class EndGreetingState extends AgentState {
    async entry(agent) {
        super.entry(agent);
        await sleep(2000);
        this.timedOut(agent);
    }

    async changed(agent) {
        // LOBBYに移るので何もしない。(default changedを使わない。使うとroom.result条件でEndGreetingStateにまた入ってしまう)
    }

    async timedOut(agent) {
        console.log(agent.roomId);
        await agent.ddp.call('room.greet', [agent.roomId, 'end']);
        await sleep(3000);
        await agent.exitRoom();
        agent.setState(this.LOBBY);
    }
}

AgentState.init();

exports.AgentState = AgentState;
