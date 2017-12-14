/* global exports */
const sleep = require('sleep-promise');
const { DDPPlus } = require('ddp-plus');


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
            this.connect(async (error, wasReconnect) => {
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
