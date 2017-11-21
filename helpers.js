/* global exports */
/* Roomsドキュメントのヘルパー関数群 */

function didGreet(room, userId, kind) {
    return room.greet && room.greet[kind] && room.greet[kind][userId];
}

function isIn(room, userId) {
    return room.mates.some(e => e.startsWith(userId));
}

exports.didGreet = didGreet;
exports.isIn = isIn;
