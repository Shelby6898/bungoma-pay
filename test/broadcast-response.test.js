const test = require('node:test');
const assert = require('node:assert/strict');

const { serializeOfficerBroadcast } = require('../broadcast-response');

test('returns only safe broadcast fields for an officer', () => {
  const doc = {
    id: 'broadcast-123',
    data: () => ({
      senderName: 'County Admin',
      message: 'System maintenance notice',
      readBy: ['officer-1'],
      recipientUids: ['officer-1', 'officer-2'],
      senderUid: 'admin-1',
      targetScope: 'all',
      targetWardId: 'ward-1'
    })
  };

  const result = serializeOfficerBroadcast(doc, 'officer-1');

  assert.deepEqual(result, {
    id: 'broadcast-123',
    senderName: 'County Admin',
    message: 'System maintenance notice',
    read: true
  });

  assert.equal(Object.hasOwn(result, 'recipientUids'), false);
  assert.equal(Object.hasOwn(result, 'readBy'), false);
  assert.equal(Object.hasOwn(result, 'senderUid'), false);
  assert.equal(Object.hasOwn(result, 'targetScope'), false);
  assert.equal(Object.hasOwn(result, 'targetWardId'), false);
});

test('reports unread when the current officer has not read the broadcast', () => {
  const doc = {
    id: 'broadcast-456',
    data: () => ({
      senderName: 'County Admin',
      message: 'Important notice',
      readBy: ['officer-2']
    })
  };

  const result = serializeOfficerBroadcast(doc, 'officer-1');

  assert.equal(result.read, false);
});

test('uses safe defaults for missing optional fields', () => {
  const doc = {
    id: 'broadcast-789',
    data: () => ({})
  };

  assert.deepEqual(
    serializeOfficerBroadcast(doc, 'officer-1'),
    {
      id: 'broadcast-789',
      senderName: 'Admin',
      message: '',
      read: false
    }
  );
});
