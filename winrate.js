#!/usr/bin/env node
/* global module exports */
const os = require('os');
const { execFile } = require('child-process-promise');
const jssgf = require('jssgf');
const { GtpLeelaZero, GtpLeela, coord2move } = require('gtp-wrapper');
const { DDPPlus } = require('ddp-plus');
const { primaryLastNode } = require('./util.js');

class GtpLeelaZero19 extends GtpLeelaZero {}
GtpLeelaZero19.init(
    '/Users/yuji/OpenSources/go_ai/leela-zero',
    './leelaz',
    ['-g', '-w', 'elf_converted_weights.txt']
);

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
                console.log('added error: ', reason);
            });
        }
        const removed = id => {
            this.removed(id).catch(function(reason) {
                console.log('removed error: ', reason);
            });
        }
        const updated = id => {
            this.updated(id).catch(function(reason) {
                if (reason.signal !== 'SIGINT') {
                    console.log('updated error: ', reason);
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
            console.log('added', this.records);
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
                console.log('added', id, this.records)
                await this.keepUpdateWinrate(id);
            }
        }
    }

    async updated(id) {
        const record = this.records[this.nth - 1];
        if (record && record.id === id) {
            // ここはsimulationが更新される度に呼ばれる
            console.log('updated', this.records, id);
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

        this.sgf = record.sgf;
        const [root] = jssgf.fastParse(this.sgf);
        const size = parseInt(root.SZ || '19');
        const rule = root.RU || (root.KM === '7.5' ? 'Chinese' : 'Japanese');
        const { num, node } = primaryLastNode(root);
        const turn = getTurn(node, root);
        // const SelectedGtpLeela = GtpLeela;
        const SelectedGtpLeela = GtpLeelaZero19; // LZを使いたいときは上をコメントアウトしてこの行を使う
        // const options = ['--threads', os.cpus().length - 1];
        const options = ['--threads', 1];
        if (SelectedGtpLeela === GtpLeela) {
            options.push('--nobook');
            if (rule === 'Japanese') {
                options.push('--komiadjust');
            }
        }
        let lastForecast = null;
        if (!this.gtp) {
            this.gtp = new SelectedGtpLeela();
            this.gtp.start(options, 0);
        }
        await this.gtp.loadSgf(this.sgf);
        await this.gtp.timeSettings(0, BYOYOMI, 1);
        await this.gtp.lzAnalyze(100, line => {
            const infos = SelectedGtpLeela.parseInfo(line);
            if (infos && infos[0]) {
                const info = infos[0];
                if (record.simulation && record.simulation.num === num && record.simulation.nodes > info.visits) {
                    return;
                }
                const winrate = Math.max(Math.min(info.winrate, 100), 0);
                const blackWinrate = turn === 'B' ? winrate : 100 - winrate;
                const pv = info.pv.map(c => coord2move(c, size));
                this.ddp.call('updateWinrate', [id, num, blackWinrate, pv, info.visits]);
                let forecast = pv[0];
                if (num == 0) {
                    forecast = normalizeMove(forecast);
                }
                if (forecast !== lastForecast) {
                    this.ddp.call('forecast', [id, num, forecast, true]);
                    lastForecast = forecast;
                }
            } else {
                console.log('stdout: %s', line);
            }
            if (this.memoryQuotaExceeded && this.gtp) {
                console.log('memory quota exceeded');
                this.gtp.terminate();
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
