/* global exports */
function sleep(delay) {
    return new Promise(function(resolve, reject) {
        setTimeout(resolve, delay);
    });
}

function ddpCallPromise(ddp, name, params) {
    return new Promise(function(res, rej) {
        ddp.call(name, params, function(error, result) {
            if (error) {
                rej(error);
            } else {
                res(result);
            }
        });
    });
}

exports.sleep = sleep;
exports.ddpCallPromise = ddpCallPromise;
