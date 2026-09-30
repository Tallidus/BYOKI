import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@byoki/core", "@byoki/react", "@byoki/server", "@byoki/providers", "@byoki/pricing"],
};

export default nextConfig;
