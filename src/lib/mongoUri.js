// A registered connection URI must include a target database name in its path,
// e.g. mongodb+srv://user:pass@cluster.mongodb.net/mydb — that name is both what
// mongodump captures and (for restores) what the target database is called.
export function extractDbName(uri) {
  const match = uri.match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^/?]+)/);
  if (!match || !match[1]) {
    throw new Error("Connection URI must include a database name, e.g. mongodb+srv://host/mydb");
  }
  return decodeURIComponent(match[1]);
}

export function redactUri(uri) {
  return uri.replace(/\/\/([^:/]+):([^@]+)@/, "//$1:****@");
}
