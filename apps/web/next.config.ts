import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // Next only serves dev resources to localhost by default; without this,
  // opening the app at 127.0.0.1 loads a page whose buttons do nothing.
  allowedDevOrigins: ["127.0.0.1"],
};

export default config;
