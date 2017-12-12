/* global exports */
const { DDPPlus } = require('ddp-plus');

async function sleep(time) {
    return new Promise(function(res, rej) {
        setTimeout(res, time);
    });
}

class DDPPlusPlus extends DDPPlus {
    async connectWithRetry(initialInterval, maxInterval, condition) {
        if (initialInterval) {
            this.initialInterval = this.interval = initialInterval;
        }
        if (maxInterval) {
            this.maxInterval = maxInterval;
        }
        if (typeof condition !== 'function' || await condition()) {
            this.connect(async (error, wasReconnect) => {
                if (error) {
                    await Promise.all(this.handlers['connect-error'].map(e => e(error)));
                    if (!this.initialInterval) {
                        return;
                    }
                    this.close();
                    await sleep(this.interval);
                    this.interval *= 2;
                    this.interval = Math.min(this.interval, this.maxInterval);
                    this.connectWithRetry();
                } else {
                    if (this.initialInterval) {
                        this.interval = this.initialInterval;
                    }
                    for (const e of this.handlers['connect-success']) {
                        e(wasReconnect);
                    }
                }
            });
        } else {
            await sleep(this.interval);
            this.interval *= 2;
            this.interval = Math.min(this.interval, this.maxInterval);
            this.connectWithRetry();
        }
    }
}

exports.DDPPlusPlus = DDPPlusPlus
