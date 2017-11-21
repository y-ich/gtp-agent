/* global exports */
function sleep(delay) {
    return new Promise(function(resolve, reject) {
        setTimeout(resolve, delay);
    });
}

exports.sleep = sleep;
