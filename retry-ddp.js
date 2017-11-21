/* global exports */
const DDPClient = require('ddp');

async function sleep(time) {
    return new Promise(function(res, rej) {
        setTimeout(res, time);
    });
}

class RetryDDP {
    constructor(config) {
        this.ddp = new DDPClient(config);
        this.ddp.on('socket-close', (code, message) => {
            console.log("socket-close: %s %s", code, message);
            for (const e of this.handlers['socket-close']) {
                e(code, message);
            }
        });
        this.ddp.on('socket-error', (error) => {
            console.log("socket-error: ", error.message);
            for (const e of this.handlers['socket-error']) {
                e(error);
            }
        });
        this.retryTime = 1000;
        this.handlers = {
            'socket-close': [],
            'socket-error': [],
            'connect-error': [],
            'connect-success': []
        };
    }

    start() {
        this.ddp.connect(async (error, wasReconnect) => {
            if (error) {
                await Promise.all(this.handlers['connect-error'].map(e => e(error)));
                this.ddp.close();
                await sleep(this.retryTime);
                this.retryTime *= 2;
                if (this.retryTime > 60000) {
                    this.retryTime = 60000;
                }
                this.start();
            } else {
                this.retryTime = 1000;
                for (const e of this.handlers['connect-success']) {
                    e(wasReconnect);
                }
            }
        });
    }

    on(event, handler) {
        this.handlers[event].push(handler);
    }
}

exports.RetryDDP = RetryDDP;
