/**
 * User mapping routes – upload, reload, members list, info lookup
 */
const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const xlsx = require("xlsx");
const { writeError } = require("../lib/helpers");
const { ensureSeatsData } = require("./seats");

module.exports = function createUserMappingRouter({ userMappingService, usageStore, teamCache }) {
  const router = express.Router();

  /* ── Multer config ── */
  const uploadStorage = multer.diskStorage({
    destination(_req, _file, cb) {
      const uploadDir = path.join(__dirname, "..", "uploads");
      if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
      cb(null, uploadDir);
    },
    filename(_req, file, cb) { cb(null, Date.now() + "-" + file.originalname); },
  });
  const upload = multer({
    storage: uploadStorage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter(_req, file, cb) {
      const allowed = [
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.ms-excel",
      ];
      if (allowed.includes(file.mimetype) || /\.xlsx?$/i.test(file.originalname)) cb(null, true);
      else cb(new Error("仅支持 .xlsx / .xls 文件"));
    },
  });

  const userDataDir = path.join(__dirname, "..", "data");

  function convertXlsxToJson(filePath) {
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw new Error("Excel 文件中没有工作表");
    const rows = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "" });
    if (!rows.length) throw new Error("文件中没有数据行");
    return rows.map((row) => ({
      "AD-name": (row["AD-name"] || "").toString().trim(),
      "AD-mail": (row["AD-mail"] || "").toString().trim(),
      "Github-name": (row["Github-name"] || "").toString().trim(),
      "Github-mail": (row["Github-mail"] || "").toString().trim(),
    }));
  }

  /* ── Page routes ── */
  router.get("/costcenter", (_req, res) => res.sendFile(path.join(__dirname, "..", "public", "costcenter.html")));
  router.get("/costcenter/:name", (_req, res) => res.sendFile(path.join(__dirname, "..", "public", "costcenter.html")));
  router.get("/user", (_req, res) => res.sendFile(path.join(__dirname, "..", "public", "user.html")));
  router.get("/analytics", (_req, res) => res.sendFile(path.join(__dirname, "..", "public", "analytics.html")));

  /* ── Upload mapping file ── */
  router.post("/user/upload-members", upload.single("file"), (req, res) => {
    try {
      if (!req.file) { res.status(400).json({ ok: false, message: "没有收到上传文件" }); return; }
      const jsonData = convertXlsxToJson(req.file.path);
      try { fs.unlinkSync(req.file.path); } catch { /* noop */ }
      const outPath = path.join(userDataDir, "user_mapping.json");
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(jsonData, null, 2), "utf8");
      const validRows = jsonData.filter((r) => r["AD-name"] && r["Github-name"]).length;
      const skipped = jsonData.length - validRows;
      res.json({ ok: true, message: `成功 ${validRows} 条，跳过 ${skipped} 条`, totalRows: jsonData.length, validRows, skipped, fileName: req.file.originalname });
    } catch (error) {
      try { if (req.file) fs.unlinkSync(req.file.path); } catch { /* noop */ }
      writeError(res, error);
    }
  });

  /* ── Manual reload mapping ── */
  router.post("/user/reload-mapping", (_req, res) => {
    try {
      userMappingService.reload();
      res.json({ ok: true, message: "映射数据已加载", count: userMappingService.getSize(), fetchedAt: userMappingService.getFetchedAt() });
    } catch (error) { writeError(res, error); }
  });

  /* ── Enriched members list ── */
  router.get("/api/user/members", async (_req, res) => {
    try {
      await ensureSeatsData(teamCache, usageStore);
      const seats = teamCache.seatsRaw;
      const members = seats.map((seat) => {
        const mapped = userMappingService.getUserByGithub(seat.login);
        return {
          login: seat.login,
          team: (teamCache.userTeamMap[seat.login] || []).join(", ") || "-",
          adName: mapped ? mapped.adName : null,
          adMail: mapped ? mapped.adMail : null,
          planType: seat.planType || "-",
          lastActivityAt: seat.lastActivityAt || null,
        };
      });
      res.json({ ok: true, loadedAt: new Date().toISOString(), total: members.length, mappedCount: members.filter((m) => m.adName !== null).length, members });
    } catch (error) { writeError(res, error); }
  });

  /* ── Lookup AD user by GitHub login ── */
  router.get("/api/user/info", (req, res) => {
    const githubName = String(req.query.github || "").trim();
    if (!githubName) { res.status(400).json({ ok: false, message: "缺少 github 参数" }); return; }
    const mapped = userMappingService.getADUserByGithubName(githubName);
    if (mapped) res.json({ ok: true, githubName: mapped.githubName, adName: mapped.adName, adMail: mapped.adMail, githubMail: mapped.githubMail });
    else res.json({ ok: false, message: "未找到映射记录", githubName });
  });

  return router;
};
