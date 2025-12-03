const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 8080;

// Simple request logging
app.use((req, res, next) => {
  const now = new Date().toISOString();
  console.log(`[${now}] ${req.method} ${req.url} - ${req.ip}`);
  next();
});

// Serve static files from /public
app.use(express.static(path.join(__dirname, "public")));

// Serve index.html at the root path
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`DocSuite UI running on port ${PORT}`);
});
