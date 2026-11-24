function timestampMillis(value) {
  if (value && typeof value.toMillis === 'function') return value.toMillis();
  if (value && typeof value.toDate === 'function') return value.toDate().getTime();
  if (value && typeof value._seconds === 'number') return value._seconds * 1000;
  if (value && typeof value.seconds === 'number') return value.seconds * 1000;

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function mergeWardReportDocs(wardNameDocs, legacyWardDocs, requestedWard) {
  const merged = new Map();

  for (const doc of legacyWardDocs) {
    const data = doc.data();
    const savedWardName = String(data.wardName || '').trim();

    if (!savedWardName && String(data.ward || '').trim() === requestedWard) {
      merged.set(doc.id, doc);
    }
  }

  for (const doc of wardNameDocs) {
    const data = doc.data();

    if (String(data.wardName || '').trim() === requestedWard) {
      merged.set(doc.id, doc);
    }
  }

  return [...merged.values()].sort((a, b) =>
    timestampMillis(b.data().createdAt) - timestampMillis(a.data().createdAt)
  );
}

module.exports = { mergeWardReportDocs };
