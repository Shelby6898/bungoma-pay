function serializeOfficerBroadcast(doc, officerUid) {
  const data = doc.data();

  return {
    id: doc.id,
    senderName: data.senderName || 'Admin',
    message: data.message || '',
    read: Array.isArray(data.readBy) && data.readBy.includes(officerUid)
  };
}

module.exports = { serializeOfficerBroadcast };
