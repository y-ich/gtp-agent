/* global exports */
const { DDPPlus } = require('ddp-plus');

async function sleep(time) {
    return new Promise(function(res, rej) {
        setTimeout(res, time);
    });
}

class DDPPlusPlus extends DDPPlus {
    async connectWithRetry(initialInterval, maxInterval, condition) {
        if (condition !== undefined) {
            this.condition = condition;
        }
        if (initialInterval) {
            this.initialInterval = this.interval = initialInterval;
        }
        if (maxInterval) {
            this.maxInterval = maxInterval;
        }
        if (typeof this.condition !== 'function' || await this.condition()) {
            console.log('try to connect');
            this.connect(async (error, wasReconnect) => {
                console.log('connected');
                if (error) {
                    this.emit('connect-error', error);
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
                    this.emit('connect-success', wasReconnect);
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
