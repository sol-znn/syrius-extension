'use strict';
// For suites that test something other than document binding: the document
// that made a request is always live and has not navigated. The binding itself
// -- navigation generations, relay activation and request tokens, probes -- is
// exercised by document-binding-test against the real modules.
const crypto = require('node:crypto');

// A fixture relay's activation token (the relay's own format is a UUID).
const activation = '11111111-1111-4111-8111-111111111111';

// Stands in for services/utils/nativeNavigation: every capture is stamped with
// the initial generation, and nothing has moved since.
const navigationStub = {
  __esModule: true,
  default: {
    capture: async target => ({ ...target, navigationTab: 'initial', navigationFrame: 'initial' }),
    matches: async target => typeof target?.navigationTab === 'string' && typeof target?.navigationFrame === 'string',
    invalidate: async () => () => false,
    forgetTab: async () => {},
  },
};
const isNavigation = id => typeof id === 'string' && /nativeNavigation(\.js)?$/.test(id);

// The fields a request carries from its document (see approvalIdentity).
const documentFields = () => ({ activation, requestToken: crypto.randomUUID(), navigationTab: 'initial', navigationFrame: 'initial' });

// A live relay's answer to what the worker sends it: a probe is accepted, a
// response is acknowledged (accepted when it is a success), an event is taken.
const relayReply = (message, now = Date.now) => (message?.kind === 'response'
  ? { accepted: !message.error, acceptedAt: now() } : { accepted: true });

module.exports = { activation, navigationStub, isNavigation, documentFields, relayReply };
