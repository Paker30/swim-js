'use strict';
var debug = require('debug');
var events = require('events');
var util = require('util');

var MessageType = require('./message-type');
var Net = require('./net');

function FailureDetector(opts) {
    this.swim = opts.swim;
    this.interval = opts.interval || FailureDetector.Default.interval;
    this.pingTimeout = opts.pingTimeout || FailureDetector.Default.pingTimeout;
    this.pingReqTimeout = opts.pingReqTimeout || FailureDetector.Default.pingReqTimeout;
    this.pingReqGroupSize = opts.pingReqGroupSize || FailureDetector.Default.pingReqGroupSize;

    this.seq = 0;
    this.pingListener = this.onPing.bind(this);
    this.pingReqListener = this.onPingReq.bind(this);
    this.ackListener = this.onAck.bind(this);

    this.tickHandle = undefined;
    this.seqToTimeout = Object.create(null);
    this.seqToCallback = Object.create(null);
    this.debug = debug('swim:failure-detector').bind(undefined, opts.debugIdentifier);
    this.trace = debug('swim:trace:failure-detector').bind(undefined, opts.debugIdentifier);
    this.local = opts.debugIdentifier;
}

util.inherits(FailureDetector, events.EventEmitter);

FailureDetector.prototype.start = function start() {
    this.swim.net.on(Net.EventType.Ping, this.pingListener);
    this.swim.net.on(Net.EventType.PingReq, this.pingReqListener);
    this.swim.net.on(Net.EventType.Ack, this.ackListener);
    this.tick();
};

FailureDetector.prototype.stop = function stop() {
    var self = this;

    clearInterval(self.tickHandle);
    self.tickHandle = undefined;

    self.swim.net.removeListener(Net.EventType.Ping, self.pingListener);
    self.swim.net.removeListener(Net.EventType.PingReq, self.pingReqListener);
    self.swim.net.removeListener(Net.EventType.Ack, self.ackListener);

    Object.keys(self.seqToTimeout).forEach(function clearTimeoutWithDeletion(seq) {
        clearTimeout(self.seqToTimeout[seq]);
        delete self.seqToTimeout[seq];
    });

    Object.keys(self.seqToCallback).forEach(function clearCallback(seq) {
        delete self.seqToCallback[seq];
    });
};

FailureDetector.prototype.tick = function tick() {
    setImmediate(this.ping.bind(this));
    this.tickHandle = setInterval(this.ping.bind(this), this.interval);
};
// This will be scheduled to ping a random member every interval
FailureDetector.prototype.ping = function ping() {
    this.pingMember(this.swim.membership.next());
};

FailureDetector.prototype.pingMember = function pingMember(member) {
    var self = this;
    var seq = self.seq;

    if (!member) {
        return;
    }

    self.seq += 1;

    self.seqToTimeout[seq] = setTimeout(function receiveTimeout() {
        self.trace('Ping timeout triggered to ', member);
        self.clearSeq(seq);
        self.pingReq(member);
    }, self.pingTimeout);

    this.trace('About to ping a member', member);
    self.swim.net.sendMessage({
        type: MessageType.Ping,
        data: {
            seq: seq,
            host: self.local
        }
    }, member.host);
};

FailureDetector.prototype.pingReq = function pingReq(member) {
    var self = this;
    var relayMembers = self.swim.membership.random(self.pingReqGroupSize);
    var timeout;

    if (relayMembers.length === 0) {
        return;
    }
    self.trace('Sending a ping req to', member);
    // This timeout marks member as suspicious
    timeout = setTimeout(function pingReqTimeout() {
        self.emit(FailureDetector.EventType.Suspect, member);
    }, self.pingReqTimeout);

    relayMembers.forEach(function pingThrough(relayMember) {
        self.pingReqThroughMember(member, relayMember, function pingReqThroughMemberCallback() {
            clearTimeout(timeout); // Clear the suspicious timeout (not suspicious)
        });
    });
};

FailureDetector.prototype.pingReqThroughMember = function pingReqThroughMember(member, relayMember, callback) {
    var self = this;
    var seq = self.seq;

    self.seq += 1;

    self.seqToTimeout[seq] = setTimeout(function receiveTimeout() {
        self.clearSeq(seq);
    }, self.pingReqTimeout);

    self.seqToCallback[seq] = function pingReqAckReceiveCallback() {
        self.clearSeq(seq);
        callback.apply(undefined, arguments);
    };
    
    self.trace('Trying to ping member', member.host , ' by ', relayMember.host);
    self.swim.net.sendMessage({
        type: MessageType.PingReq,
        data: {
            seq: seq,
            host: self.local,
            destination: member.host
        }
    }, relayMember.host);
};

/**
 * Returns an ACK when you receive a ping request
 * @function onPing
 * @param  {type} data {description}
 * @param  {type} host {description}
 * @return {type} {description}
 */
FailureDetector.prototype.onPing = function onPing(data, host) {
    this.trace('We got a pin!', data, host);
    this.swim.net.sendMessage({
        type: MessageType.Ack,
        data: {
            seq: data.seq,
            host: this.local
        }
    }, host);
};
/**
 * A.K.A. pingReqListener when binded
 * Executes a ping request on behalf of other node
 * @function onPingReq
 * @param  {Object} data {description}
 * @param  {String} host {description}
 * @return {void}
 */
FailureDetector.prototype.onPingReq = function onPingReq(data, host) {
    var self = this;
    var seq = self.seq;

    self.seq += 1;
    this.trace('We got a pin request (on behalf)', data, host);

    self.seqToTimeout[seq] = setTimeout(function receiveTimeout() {
        self.clearSeq(seq);
    }, self.pingTimeout);
    // Save an fn that send the ACK to the requester
    self.seqToCallback[seq] = function pingAckReceiveCallback() {
        self.clearSeq(seq);
        self.swim.net.sendMessage({
            type: MessageType.Ack,
            data: {
                seq: data.seq
            }
        }, host);
    };

    self.swim.net.sendMessage({
        type: MessageType.Ping,
        data: {
            seq: seq,
            host: data.destination
        }
    }, data.destination);
};

FailureDetector.prototype.onAck = function onAck(data) {
    var callback = this.seqToCallback[data.seq];
    this.trace('Got ACK ', data);
    if (callback) {
        process.nextTick(callback);
    }

    this.clearSeq(data.seq);
};

FailureDetector.prototype.clearSeq = function clearSeq(seq) {
    clearTimeout(this.seqToTimeout[seq]);
    delete this.seqToCallback[seq];
    delete this.seqToTimeout[seq];
};

FailureDetector.Default = {
    interval: 20,
    pingTimeout: 4,
    pingReqTimeout: 12,
    pingReqGroupSize: 3
};

FailureDetector.EventType = {
    Suspect: 'suspect'
};

module.exports = FailureDetector;
