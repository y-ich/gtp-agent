/* global exports */
const os = require('os');
const { ddpCallPromise } = require('./util.js');
const { GtpLeela } = require('gtp-wrapper');
const { chat, Agent } = require('./agent.js');


class GtpLeela2 extends GtpLeela {
    constructor(agent) {
        super();
        this.agent = agent;
        this.winRate = null;
    }
    genmoveStderrHandler(line) {
        super.genmoveStderrHandler(line);
        const match = line.match(/^Nodes:\s+([0-9]+), Win:\s+([.0-9]+)%.*, PV:(.+)$/);
        if (match) {
            this.winRate = parseFloat(match[2]);
            this.ddp.call('updateRooms', [
                this.agent.roomId,
                { $set: { 'kakoWinRate': this.winRate }}
            ]);
            this.agent.checkUnexpected(this.winrate);
        }
    }
}


/**
 * ポンダーAIエージェント
 */
class ChatAgent extends Agent {
    constructor(...args) {
        super(...args);
        this.ponder = null;
        this.wasUnexpected = false;
        this.roomsCursorOptions = { fields: { kakoHistory: 0 }};
    }

    async startGtp(sgf) {
        this.gtp = new GtpLeela2(this);
        await this.gtp.loadSgf(sgf, ['--komiadjust', '--threads', Math.min(7, os.cpus().length - 1)]); // 7threadsはメモリ512MBでは足らない模様
        await this.gtp.timeSettings(0, this.byoyomi, 1);
    }

    async opponentPlay(root, node) {
        const coord = this.opponentMove(root, node);
        if (coord) {
            await this.gtp.play(coord);
            this.ponder = {
                actual: coord,
                variations: this.gtp.info.variations
            };
            this.commentOnMove();
            await ddpCallPromise(this.ddp, 'updateRooms', [this.roomId, {
                $push: { kakoHistory: {
                    winRate: this.gtp.info.variations[0].winRate,
                    ponder: this.gtp.info.variations
                }}
            }]).catch(function(reason) {
                console.log(reason);
            });
        }
    }

    async play(root, node) {
        const data = await super.play(root, node);
        data.color = this.color;
        await ddpCallPromise(this.ddp, 'updateRooms', [this.roomId, {
            $set: {
                kakoWinRate: data.winRate,
                aiThought: data
            },
            $push: { kakoHistory: {
                num: this.num,
                winRate: data.winRate
            }}
        }]).catch(function(reason) {
            console.log(reason);
        });
        return data;
    }

    commentOnMove() {
        if (this.ponder.variations[0].winRate <= 20) { // 勝勢なら
            return;
        }

        let message;
        let i;
        for (i = 0; i < this.ponder.variations.length; i++) {
            const variation = this.ponder.variations[i];
            if (this.ponder.actual === variation.move) {
                if (variation.rollouts > 0) {
                    if (this.gtp.info && this.gtp.info.winRate) {
                        const improvement = this.gtp.info.winRate - variation.winRate;
                        if (improvement > 20) {
                            message = 'ええっ';
                            break;
                        } else if (improvement > 10) {
                            message = 'おっ';
                            break;
                        } else if (improvement < -20) {
                            message = 'あいたた';
                            break;
                        } else if (improvement < -10) {
                            message = 'あっ';
                            break;
                        }
                    }
                    if (variation.winRate > 50) { // 相手が有利
                        switch (i) {
                            case 0:
                            message = 'う';
                            break;
                            case 1:
                            message = 'うーん';
                            break;
                            case 2:
                            message = 'むむ';
                            break;
                            case 3:
                            message = 'ふぅ';
                            break;
                            case 4:
                            message = 'なかなか';
                            break;
                            case 5:
                            message = 'それは';
                            break;
                        }
                    } else { // 自分が有利
                        switch (i) {
                            case 0:
                            message = 'うんうん';
                            break;
                            case 1:
                            message = 'なるほど';
                            break;
                            case 2:
                            message = 'そうですか';
                            break;
                            case 3:
                            message = 'ほーー';
                            break;
                            case 4:
                            message = 'ほほーー';
                            break;
                            case 5:
                            message = 'ふむふむ';
                            break;
                        }
                    }
                } else {
                    message = 'あるとは思ったけど';
                }
                break;
            }
        }
        if (i === this.ponder.variations.length) {
            message = 'おお?';
            this.wasUnexpected = true;
        } else {
            this.wasUnexpected = false;
        }
        if (message) {
            chat.chat(this.roomId, this.user, message, 'ja');
        }
    }

    checkUnexpected(winRate) {
        if (!this.wasUnexpected || !this.ponder) {
            return;
        }
        if (winRate < 100 - this.ponder.variations[0].winRate) {
            chat.chatP(this.roomId, this.user.fetch()[0], '感心しました', 'ja');
            this.wasUnexpected = false;
        }
    }

    say(message, lang) {
        if (this.roomId) {
            chat.chat(this.roomId, this.user, message, lang);
        }
    }
}

exports.ChatAgent = ChatAgent;