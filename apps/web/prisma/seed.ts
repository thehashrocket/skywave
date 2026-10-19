import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });

// Frequencies that are reliably active, so there's always something to try.
const presets = [
  { name: "WWV time signal, 5 MHz", freqKhz: 5000, mode: "am" },
  { name: "WWV time signal, 10 MHz", freqKhz: 10000, mode: "am" },
  { name: "WWV time signal, 15 MHz", freqKhz: 15000, mode: "am" },
  { name: "75m ham voice (evenings)", freqKhz: 3900, mode: "lsb" },
  { name: "40m ham voice", freqKhz: 7200, mode: "lsb" },
  { name: "40m Morse code", freqKhz: 7030, mode: "cw" },
  { name: "31m broadcast band", freqKhz: 9600, mode: "am" },
  { name: "20m ham voice (daytime)", freqKhz: 14250, mode: "usb" },
];

async function main() {
  if ((await db.preset.count()) > 0) {
    console.log("Presets already exist; skipping seed.");
    return;
  }
  await db.preset.createMany({ data: presets });
  console.log(`Seeded ${presets.length} presets.`);
}

main().finally(() => db.$disconnect());
