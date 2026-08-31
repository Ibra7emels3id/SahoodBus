import { Db, MongoClient } from "mongodb";

const databaseName = "sahood_bus_booking";
let clientPromise: Promise<MongoClient> | null = null;

export async function getMongoDb(): Promise<Db> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is required");
  if (!clientPromise) {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 });
    console.log(client);
    clientPromise = client.connect();
  }
  return (await clientPromise).db(databaseName);
}
