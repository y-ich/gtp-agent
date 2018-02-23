#!/usr/bin/env node
/* global module exports */
const os = require('os');
const { execFile } = require('child-process-promise');
const jssgf = require('jssgf');
const { GtpLeela, coord2move } = require('gtp-wrapper');
const { DDPPlus } = require('ddp-plus');
const { primaryLastNode } = require('./util.js');

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
    constructor(ddp, nth) {
        this.ddp = ddp;
        this.nth = nth;
        console.log('LeelaClient nth %d', this.nth);
        this.records = [];
        this.gtp = null;
        this.sgf = null;
        this.memoryQuotaExceeded = false;
    }

    async start() {
        // forecastメソッドのために
        this.ddp.call('becomeKako', []);

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
                console.log('updated error: ', reason);
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

        const handleConstants = this.handleConstants.bind(this);
        this.constantsObserver = this.ddp.observe('constants', handleConstants, handleConstants);
        this.constantsSubscriptionId = this.ddp.subscribe('constants', [{ category: process.env.HEROKU_APP_NAME }]);
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
        if (this.records[this.nth - 1] !== target) {
            await this.stopUpdateWinrate();
            if (this.records[this.nth - 1]) {
                console.log('target changed');
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
        const options = ['--nobook', '--threads', os.cpus().length - 1];
        if (rule === 'Japanese') {
            options.push('--komiadjust');
        }
        let lastForecast = null;
        const { instance, promise } = GtpLeela.genmoveFrom(this.sgf, BYOYOMI,
            'gtp', options, 0, line => {
            const match = line.match(/^Nodes: ([0-9]+), Win: ([.0-9]+)%.*, PV:((?:\s[A-Z][0-9]{1,2})+)/);
            if (match) {
                const nodes = parseInt(match[1]);
                if (record.simulation && record.simulation.num === num && record.simulation.nodes > nodes) {
                    return;
                }
                const winrate = Math.max(Math.min(parseFloat(match[2]), 100), 0);
                const blackWinrate = turn === 'B' ? winrate : 100 - winrate;
                const pv = match[3].trim().split(/\s+/).map(c => coord2move(c, size));
                this.ddp.call('updateWinrate', [id, num, blackWinrate, pv, nodes]);
                let forecast = pv[0];
                if (num == 0) {
                    forecast = normalizeMove(forecast);
                }
                if (forecast !== lastForecast) {
                    this.ddp.call('forecast', [id, num, forecast, true]);
                    lastForecast = forecast;
                }
            } else {
                console.log('stderr: %s', line);
            }
            if (this.memoryQuotaExceeded) {
                this.stopUpdateWinrate();
                console.log('memory quota exceeded');
            }
        });
        this.gtp = instance;
        const data = await promise;
        let forecast = coord2move(data.result, size);
        if (num == 0) {
            forecast = normalizeMove(forecast);
        }
        if (forecast !== lastForecast) {
            this.ddp.call('forecast', [id, num, forecast, true]);
            lastForecast = forecast;
        }
    }

    async stopUpdateWinrate() {
        if (this.gtp) {
            await this.gtp.terminate();
            this.gtp = null;
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
    const client = new LeelaClient(ddp, parseInt(process.argv[2] || '1'));
    ddp.addListener('connect-success', async function(wasReconnect) {
        if (wasReconnect) {
            await client.destroy();
        }
        client.start();
    });
    ddp.addListener('socket-close', async function(code, reason) {
        await client.destroy();
    });
    ddp.connectWithRetry(1000, 60000);
}
