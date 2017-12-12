#!/usr/bin/env node
/* global module */
const { MongoClient } = require('mongodb');
const { DDPPlus } = require('ddp-plus');
const { DDPPlusPlus } = require('./ddp-plusplus');
const { LeelaClient } = require('./winrate.js');
const { ChatAgent } = require('./chat-agent.js');

const MIMIAKA_SERVER = process.env.NODE_ENV === 'production' ?
    'wss://mimiaka.herokuapp.com/websocket' :
    'ws://localhost:3000/websocket';
const TWIIGO_SERVER = process.env.NODE_ENV === 'production' ?
    'wss://twiigo.herokuapp.com/websocket' :
    'ws://localhost:4000/websocket';

if (require.main === module) {
    const mimiaka = new DDPPlus({ url: MIMIAKA_SERVER });
    const twiigo = new DDPPlusPlus({ url: TWIIGO_SERVER });
    const winrate = new LeelaClient(mimiaka, parseInt(process.argv[3] || '1'));
    const agent = new ChatAgent(twiigo, 'twiigo2015', parseInt(process.argv[2] || '15'));
    let winrateBusy = false;

    winrate.onTargetAdded = async function() {
        agent.say('急用が入りました。ごめんなさい。失礼します', 'ja');
        await agent.stop();
        twiigo.stopRetry();
        twiigo.close();
        winrateBusy = true;
    }
    winrate.onTargetRemoved = async function() {
        console.log('onTargetRemoved');
        winrateBusy = false;
        twiigo.connectWithRetry(1000, 60000);
    }
    mimiaka.on('connect-success', async function(wasReconnect) {
        if (wasReconnect) {
            await winrate.destroy();
        }
        winrate.start();
    });
    mimiaka.on('connect-error', async function(error) {
        await winrate.destroy();
    });

    twiigo.on('connect-success', async function(wasReconnect) {
        if (wasReconnect) {
            await agent.stop();
        }
        if (!winrateBusy) {
            agent.start();
        }
    });
    twiigo.on('connect-error', async function(error) {
        await agent.stop();
    });

    mimiaka.connectWithRetry(1000, 60000);
    twiigo.connectWithRetry(1000, 60000, function() {
        return new Promise(function(res, rej) {
            MongoClient.connect(process.env.TWIIGO_MONGO_URL, (error, db) => {
                if (error) {
                    res(false);
                    return;
                }
                const Constants = db.collection('constants');
                if (!Constants) {
                    res(false);
                    return;
                }
                Constants.findOne({ category: 'heroku-state' }, function(error, item) {
                    if (error || !item) {
                        res(false);
                        return;
                    }
                    console.log('heroku-state', item.sleep);
                    res(!item.sleep);
                });
            });
        });
    });
}
