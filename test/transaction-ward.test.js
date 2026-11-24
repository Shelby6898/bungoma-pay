const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeWardReportDocs } = require('../transaction-ward');

function doc(id, data) {
  return { id, data: () => data };
}

test('includes corrected wardName records and legacy records without wardName', () => {
  const corrected = doc('new-1', {
    wardName: 'Musikoma',
    ward: 'Kanduyi',
    createdAt: new Date('2026-11-24T10:00:00Z')
  });
  const legacy = doc('old-1', {
    ward: 'Musikoma',
    createdAt: new Date('2026-11-23T10:00:00Z')
  });

  const result = mergeWardReportDocs([corrected], [legacy], 'Musikoma');

  assert.deepEqual(result.map(item => item.id), ['new-1', 'old-1']);
});

test('does not treat an incorrect legacy ward as authoritative when wardName exists', () => {
  const wrongLegacyValue = doc('wrong-1', {
    ward: 'Kanduyi',
    wardName: 'Musikoma',
    createdAt: new Date('2026-11-24T10:00:00Z')
  });

  assert.deepEqual(
    mergeWardReportDocs([], [wrongLegacyValue], 'Kanduyi'),
    []
  );
});

test('deduplicates documents and sorts newest first', () => {
  const older = doc('same-id', {
    wardName: 'Musikoma',
    createdAt: new Date('2026-11-22T10:00:00Z')
  });
  const newer = doc('newer', {
    wardName: 'Musikoma',
    createdAt: new Date('2026-11-24T10:00:00Z')
  });

  const result = mergeWardReportDocs(
    [older, newer],
    [older],
    'Musikoma'
  );

  assert.deepEqual(result.map(item => item.id), ['newer', 'same-id']);
});
