-- carry each part code's design wall onto its CVI results before the asset column drops
UPDATE "result_cvi" rc
SET "nominal_wall_mm" = pc."nominal_wall_mm"
FROM "result" r
JOIN "part_code" pc ON pc."part_code_id" = r."part_code_id"
WHERE r."result_id" = rc."result_id"
  AND pc."nominal_wall_mm" IS NOT NULL;
