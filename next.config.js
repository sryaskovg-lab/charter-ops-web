/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // @react-pdf/renderer is already on Next.js 14's own built-in externalization list, so it
    // doesn't need to be listed here — but pdfkit (react-pdf's internal PDF engine) isn't, and
    // it loads its standard-fonts/*.cjs files via a computed path Next's bundler can't trace,
    // hence the runtime "Cannot find module .../Helvetica.cjs" once deployed.
    serverComponentsExternalPackages: ["pdfkit"],
    // Belt-and-suspenders for the same root cause: forces Vercel's file tracer to actually
    // include those font files in the deployed function for the report route, since it can't
    // discover them itself via static analysis.
    outputFileTracingIncludes: {
      "/api/reports/generate": ["./node_modules/pdfkit/js/**/*"],
    },
  },
};

module.exports = nextConfig;
