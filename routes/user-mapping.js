/**
 * User mapping routes – upload, reload, members list, info lookup
 */
const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const ExcelJS = require("exceljs");
const { writeError, buildMemberExcelRows } = require("../lib/helpers");
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

  async function convertXlsxToJson(filePath) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const worksheet = workbook.worksheets[0];
    if (!worksheet) throw new Error("Excel 文件中没有工作表");

    // 取第一行作为 header
    const headerRow = worksheet.getRow(1);
    const headers = [];
    headerRow.eachCell({ includeEmpty: true }, (cell, colNum) => {
      headers[colNum] = String(cell.value || "").trim();
    });

    const rows = [];
    worksheet.eachRow({ includeEmpty: false }, (row, rowNum) => {
      if (rowNum === 1) return; // 跳过 header
      const obj = {};
      row.eachCell({ includeEmpty: true }, (cell, colNum) => {
        const key = headers[colNum] || String(colNum);
        obj[key] = cell.value != null ? String(cell.value).trim() : "";
      });
      rows.push(obj);
    });

    if (!rows.length) throw new Error("文件中没有数据行");
    return rows.map((row) => ({
      "AD-name": (row["AD-name"] || "").trim(),
      "AD-mail": (row["AD-mail"] || "").trim(),
      "Github-name": (row["Github-name"] || "").trim(),
      "Github-mail": (row["Github-mail"] || "").trim(),
    }));
  }

  /* ── Page routes ── */
  router.get("/costcenter", (_req, res) => res.sendFile(path.join(__dirname, "..", "public", "costcenter.html")));
  router.get("/costcenter/:name", (_req, res) => res.sendFile(path.join(__dirname, "..", "public", "costcenter.html")));
  router.get("/user", (_req, res) => res.sendFile(path.join(__dirname, "..", "public", "user.html")));
  router.get("/analytics", (_req, res) => res.sendFile(path.join(__dirname, "..", "public", "analytics.html")));

  /* ── Upload mapping file ── */
  router.post("/user/upload-members", upload.single("file"), async (req, res) => {
    try {
      if (!req.file) { res.status(400).json({ ok: false, message: "没有收到上传文件" }); return; }
      const jsonData = await convertXlsxToJson(req.file.path);
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
      const seatLookup = userMappingService.buildLookup(seats.map((s) => s.login));
      const members = seats.map((seat) => {
        const mapped = seatLookup[seat.login.toLowerCase()] || null;
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

  /* ── Export members to Excel ── */
  router.get("/api/user/members/export", async (_req, res) => {
    try {
      await ensureSeatsData(teamCache, usageStore);
      const seats = teamCache.seatsRaw;
      const seatLookup = userMappingService.buildLookup(seats.map((s) => s.login));
      const members = seats.map((seat) => {
        const mapped = seatLookup[seat.login.toLowerCase()] || null;
        return {
          login: seat.login,
          team: (teamCache.userTeamMap[seat.login] || []).join(", ") || "-",
          adName: mapped ? mapped.adName : null,
          adMail: mapped ? mapped.adMail : null,
          planType: seat.planType || null,
          lastActivityAt: seat.lastActivityAt || null,
        };
      });

      const rows = buildMemberExcelRows(members);
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("用户映射");
      // Set column widths based on content type
      sheet.columns = [
        { width: 25 }, // Github 用户名
        { width: 30 }, // Team
        { width: 25 }, // AD 用户名
        { width: 35 }, // AD 邮箱
        { width: 15 }, // 计划
        { width: 22 }, // 最后活跃
        { width: 12 }, // 映射状态
      ];
      for (const row of rows) {
        sheet.addRow(row);
      }
      // Bold the header row
      sheet.getRow(1).font = { bold: true };

      const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="user-mapping-${dateStr}.xlsx"`);
      await workbook.xlsx.write(res);
      res.end();
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
