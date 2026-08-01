// A change-stream event's clusterTime is a BSON Timestamp with plain numeric
// .t (seconds) / .i (increment) properties — confirmed against a live change
// stream; its .toJSON() is a lossy combined 64-bit string, not usable here.
export function toPlainClusterTime(bsonTimestamp) {
  return { t: Number(bsonTimestamp.t), i: Number(bsonTimestamp.i) };
}

export function compareClusterTime(a, b) {
  if (a.t !== b.t) return a.t - b.t;
  return a.i - b.i;
}
