/* global exports */
function sleep(delay) {
    return new Promise(function(resolve, reject) {
        setTimeout(resolve, delay);
    });
}

function primaryLastNode(root) {
    let num = 0;
    let node = root;
    while (node._children.length > 0) {
        node = node._children[0];
        if (node.B || node.W) {
            num += 1;
        }
    }
    return { num, node };
}

exports.sleep = sleep;
exports.primaryLastNode = primaryLastNode;
