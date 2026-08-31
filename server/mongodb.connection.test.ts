import { MongoClient } from "mongodb";
import { describe, expect, it } from "vitest";

describe("اتصال MongoDB", () => {
  it("ينفذ ping باستخدام رابط الاتصال الآمن", async () => {
    const uri = process.env.MONGODB_URI;
    expect(uri, "MONGODB_URI is required").toBeTruthy();
    const client = new MongoClient(uri!, { serverSelectionTimeoutMS: 10_000 });
    try {
      const result = await client.db("admin").command({ ping: 1 });
      expect(result.ok).toBe(1);
    } finally {
      await client.close();
    }
  }, 15_000);
});
