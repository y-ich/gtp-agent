#!/usr/bin/env node
/* global module exports */
const { execFile } = require('child-process-promise');
const jssgf = require('jssgf');
const { GtpLeelaZero, coord2move, move2coord } = require('gtp-wrapper');
const { DDPPlus } = require('ddp-plus');
const { primaryLastNode } = require('./util.js');

class GtpLeelaZero19 extends GtpLeelaZero {}
GtpLeelaZero19.init(
    '/Users/yuji/OpenSources/go_ai/leela-zero',
    './leelaz',
    ['-g', '-w', 'elf_converted_weights.txt.gz']
);

function continuingNode(prev, next) {
    function equalNode(a, b) {
        // TODO: 配列プロパティに対応する
        for (const k in a) {
            if (k === '_children') {
                continue;
            }
            if (a[k] !== b[k]) {
                return false;
            }
        }
        return true;
    }
    try {
        let [pNode] = jssgf.fastParse(prev);
        let [nNode] = jssgf.fastParse(next);
        if (!equalNode(pNode, nNode)) {
            return null;
        }
        while (pNode._children.length > 0) {
            pNode = pNode._children[0];
            nNode = nNode._children[0];
            if (!equalNode(pNode, nNode)) {
                return null;
            }
        }
        return nNode._children[0];
    } catch (e) {
        return null;
    }
}

const BYOYOMI = 57600; // 16時間(5時封じ手から翌朝9時を想定)。free dynoの場合40分程度でmemory quota exceededになる
const MIMIAKA_SERVER = process.env.NODE_ENV === 'production' ?
    'wss://mimiaka.herokuapp.com/websocket' :
    'ws://localhost:3000/websocket';

if (!process.env.HEROKU_APP_NAME) {
    process.env.HEROKU_APP_NAME = 'localhost';
}

function getTurn(node, root) {
    if (node.B != null) {
        return 'W';
    } else if (node.W != null) {
        return 'B';
    } else if (node === root) {
        if (root.HA && parseInt(root.HA) >= 2) {
            return 'W';
        } else {
            return 'B';
        }
    } else {
        throw new Error('unkonwn');
    }
}

function normalizeMove(move) {
    move = move.replace(/^[a-i]/, e => String.fromCharCode('j'.charCodeAt(0) * 2 - e.charCodeAt(0)));
    move = move.replace(/[k-s]$/, e => String.fromCharCode('j'.charCodeAt(0) * 2 - e.charCodeAt(0)));
    return move;
}

const PS_OPTIONS = process.env.HEROKU_APP_NAME ? ['xl', '--sort', '-rss'] : ['xl', '-m'];

class LeelaClient {
    constructor(ddp) {
        this.ddp = ddp;
        this.nth = null;
        this.records = [];
        this.gtp = null;
        this.sgf = null;
        this.size = 19;
        this.num = 0;
        this.memoryQuotaExceeded = false;
    }

    async start() {
        // forecastメソッドのために
        await new Promise((res, rej) => {
            this.ddp.call('becomeKako', [], function(e, r) {
                if (e) {
                    rej(e);
                } else {
                    res(r);
                }
            });
        });

        await new Promise((res, rej) => {
            const handleConstants = this.handleConstants.bind(this);
            this.constantsObserver = this.ddp.observe('constants', id => {
                this.nth = this.ddp.collections.constants[id].number || 1;
                console.log('LeelaClient nth %d', this.nth);
                res();
            }, handleConstants);
            this.constantsSubscriptionId = this.ddp.subscribe('constants', [{ category: process.env.HEROKU_APP_NAME }]);
        });

        const added = id => {
            this.added(id).catch(function(reason) {
                console.error('added error: ', reason);
            });
        }
        const removed = id => {
            this.removed(id).catch(function(reason) {
                console.error('removed error: ', reason);
            });
        }
        const updated = id => {
            this.updated(id).catch(function(reason) {
                if (reason.signal !== 'SIGINT') {
                    console.error('updated error: ', reason);
                    console.log(this.sgf);
                }
            });
        };

        // 最初のaddedイベントを受け取るためには、observeはsubscribeの前に。
        this.recordsObserver = this.ddp.observe('records', added, updated, removed);
        this.recordsSubscriptionId = this.ddp.subscribe('records', [
            {
                deleted: { $ne: true },
                live: true,
                club: { $ne: true },
                /*
                    { $not: { $regex: '正規表現' }はMongoDBはサポートしていない。
                    { $not: /正規表現/ }はサポートしている。
                    ddp-ejsonは/正規表現/を{}に変換する。
                    なので、{ $not: { $regex: '正規表現' }を送って、耳赤側で{ $not: /正規表現/ }に変換することにした。
                */
                sgf: { $not: { $regex: 'RE\\[.+?\\]' }}
            },
            {
                sort: { createdAt: 1 },
                limit: this.nth,
                fields: {
                    sgf: 1,
                    simulation: 1,
                    createdAt: 1
                }
            }
        ]);
    }

    async destroy() {
        await this.stopUpdateWinrate();
        if (this.constantsSubscriptionId) {
            this.ddp.unsubscribe(this.constantsSubscriptionId);
        }
        if (this.constantsObserver) {
            this.constantsObserver.stop();
        }
        if (this.recordsSubscriptionId) {
            this.ddp.unsubscribe(this.recordsSubscriptionId);
        }
        if (this.recordsObserver) {
            this.recordsObserver.stop();
        }
    }

    async added(id) {
        const target = this.records[this.nth - 1];
        if (this.records.filter(e => e.id === id).length === 0) {
            this.records.push({
                id,
                createdAt: this.ddp.collections.records[id].createdAt
            });
            this.records.sort((a, b) => a.createAt - b.createAt);
            if (target && target !== this.records[this.nth - 1]) { // ターゲットが変わったら
                await this.stopUpdateWinrate();
            }
            if (this.records[this.nth - 1] && this.records[this.nth - 1].id === id) {
                if (this.onTargetAdded) {
                    await this.onTargetAdded();
                }
                await this.keepUpdateWinrate(id);
            }
        } else {
            console.log('added twice', id);
        }
    }

    async updated(id) {
        const record = this.records[this.nth - 1];
        if (record && record.id === id) {
            // ここはsimulationが更新される度に呼ばれる
            await this.keepUpdateWinrate(id);
        }
    }

    async removed(id) {
        console.log('removed');
        const [removed] = this.records.filter(e => e.id === id);
        if (!removed) {
            console.log('removed: ないものがremoveされた');
            return;
        }
        const target = this.records[this.nth - 1];
        this.records.splice(this.records.indexOf(removed), 1);
        console.log('removed', this.records);
        if (this.records[this.nth - 1] !== target) {
            await this.stopUpdateWinrate();
            if (this.records[this.nth - 1]) {
                console.log('target changed', this.records[this.nth - 1].id);
                await this.keepUpdateWinrate(this.records[this.nth - 1].id);
            } else if (this.onTargetRemoved) {
                console.log('target changed');
                await this.onTargetRemoved();
            }
        }
    }

    async keepUpdateWinrate(id) {
        const record = this.ddp.collections.records[id];
        if (this.sgf === record.sgf) {
            return; // simulationの更新の時は何もしない
        }
        console.log('keepUpdateWinrate', id);
        await this.stopUpdateWinrate();
        if (this.memoryQuotaExceeded) {
            await new Promise((res, rej) => {
                this.ddp.call('resetMemoryQuotaExceeded', [process.env.HEROKU_APP_NAME], function(e, r) {
                    if (e) {
                        rej(e);
                    } else {
                        res(r);
                    }
                });
            });
            this.memoryQuotaExceeded = false;
        }

        let cNode = continuingNode(this.sgf, record.sgf);
        this.sgf = record.sgf;
        let turn;
        if (cNode) {
            try {
                while (true) {
                    if (cNode.B) {
                        this.gtp.play(move2coord(cNode.B, this.size));
                        turn = 'W';
                        this.num += 1;
                    } else if (cNode.W) {
                        this.gtp.play(move2coord(cNode.W, this.size));
                        turn = 'B';
                        this.num += 1;
                    }
                    if (cNode._children.length === 0) {
                        break;
                    }
                    cNode = cNode._children[0];
                }
            } catch (e) {
                console.error(e);
                cNode = null;
            }
        }
        if (!cNode) {
            const [root] = jssgf.fastParse(this.sgf);
            this.size = parseInt(root.SZ || '19');
            const lastNode = primaryLastNode(root);
            this.num = lastNode.num;
            const node = lastNode.node;
            turn = getTurn(node, root);
            const options = ['--threads', 1];
            if (!this.gtp) {
                this.gtp = new GtpLeelaZero19();
                this.gtp.start(options, 0);
            }
            await this.gtp.loadSgf(this.sgf);
            await this.gtp.timeSettings(0, BYOYOMI, 1);
        }
        let lastForecast = null;
        await this.gtp.lzAnalyze(100, line => {
            const infos = GtpLeelaZero19.parseInfo(line);
            if (infos && infos[0]) {
                infos.forEach(e => {
                    e.pv = e.pv.map(c => coord2move(c, this.size));
                });
                const info = infos[0];
                if (record.simulation && record.simulation.num === this.num && record.simulation.nodes > info.visits) {
                    return;
                }
                const winrate = Math.max(Math.min(info.winrate, 100), 0);
                const blackWinrate = turn === 'B' ? winrate : 100 - winrate;
                const candidates = infos.map(e => [e.pv[0], Math.max(Math.min(e.winrate, 100), 0)]);
                const pv = info.pv;
                this.ddp.call('updateWinrate', [id, this.num, blackWinrate, pv, info.visits, candidates]);
                let forecast = pv[0];
                if (this.num == 0) {
                    forecast = normalizeMove(forecast);
                }
                if (forecast !== lastForecast) {
                    this.ddp.call('forecast', [id, this.num, forecast, true]);
                    lastForecast = forecast;
                }
            } else {
                console.log('parseInfo', line);
            }
            if (this.memoryQuotaExceeded && this.gtp) {
                console.log('memory quota exceeded');
                this.gtp.terminate();
                this.gtp = null;
            }
        });
    }

    async stopUpdateWinrate() {
        if (this.gtp) {
            await this.gtp.name();
        }
    }

    async handleConstants(id) {
        this.memoryQuotaExceeded = this.ddp.collections.constants[id].memoryQuotaExceeded;
        if (this.memoryQuotaExceeded) {
            console.log('handleConstants: %s, %s', id, this.memoryQuotaExceeded);
            const { stdout, stderr } = await execFile('ps', PS_OPTIONS);
            console.log(stdout);
            console.log(stderr);
        }
    }
}


exports.LeelaClient = LeelaClient;

if (require.main === module) {
    process.on('uncaughtException', function (err) {
        console.log('uncaughtException: ', err);
    });

    const ddp = new DDPPlus({ url: MIMIAKA_SERVER });
    const client = new LeelaClient(ddp);
    ddp.addListener('connect-success', async function(wasReconnect) {
        console.log('connect-success');
        if (wasReconnect) {
            await client.destroy();
        }
        client.start();
    });
    ddp.addListener('socket-close', async function(code, reason) {
        console.log('socket-close');
        await client.destroy();
    });
    ddp.connectWithRetry(1000, 60000);
}
