import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@byoki/core", "@byoki/react", "@byoki/server", "@byoki/providers", "@byoki/pricing"],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/artifacts/:file",
        headers: [
          { key: "Content-Disposition", value: "attachment" },
          { key: "Cache-Control", value: "public, max-age=300" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default nextConfig;
