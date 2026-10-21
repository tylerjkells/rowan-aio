// The ODS query behind People → Update from ODS: Rowan Online and Vijay's
// team, in the columns the directory import reads (Name, Title, Department,
// Email, Phone, Manager). Written against ODSMGR's EMPLOYEE, PERSON_DETAIL
// and TELEPHONE views as Rowan's ODS has them.

export const DIRECTORY_SQL = `-- People directory for Rowan AIO: everyone in Rowan Online, plus B. Vijayakumar,
-- and everyone who reports up to either of them. Export the results as CSV,
-- then People -> Update from ODS -> Choose CSV.
-- The team is picked from EMPLOYEE first; names and phones are then looked up
-- for just those people, since PERSON_DETAIL and TELEPHONE cover everyone in ODS.
WITH emp AS (
  -- one row per active or on-leave employee: their primary job
  SELECT /*+ MATERIALIZE */ person_uid, name, position_title, home_organization_desc, supervisor_uid
    FROM (SELECT e.person_uid, e.name, e.position_title, e.home_organization_desc, e.supervisor_uid,
                 ROW_NUMBER() OVER (PARTITION BY e.person_uid
                                    ORDER BY CASE e.position_contract_type WHEN 'P' THEN 0 ELSE 1 END,
                                             e.effective_date DESC) AS rn
            FROM odsmgr.employee e
           WHERE e.employee_status IN ('A', 'L'))
   WHERE rn = 1
),
team AS (
  -- the starting points, then everyone under them, however many levels down
  SELECT /*+ MATERIALIZE */ DISTINCT person_uid, supervisor_uid, position_title, home_organization_desc
    FROM emp
   START WITH UPPER(home_organization_desc) LIKE '%ROWAN ONLINE%'
           OR UPPER(name) LIKE 'VIJAY%, B%'
           OR UPPER(name) LIKE 'B% VIJAY%'
 CONNECT BY NOCYCLE PRIOR person_uid = supervisor_uid
),
nm AS (
  -- names the way people go by them, and their Rowan email: the team and their managers only.
  -- Banner's FNU ("first name unknown") placeholder is left off.
  SELECT person_uid,
         LTRIM(CASE WHEN UPPER(COALESCE(preferred_first_name, first_name)) <> 'FNU'
                    THEN COALESCE(preferred_first_name, first_name) END || ' ' || last_name) AS full_name,
         CASE WHEN LOWER(email_preferred_address) LIKE '%@rowan.edu'
              THEN LOWER(email_preferred_address) END AS email
    FROM odsmgr.person_detail
   WHERE person_uid IN (SELECT person_uid FROM team UNION SELECT supervisor_uid FROM team)
),
phone AS (
  -- an office line, never a home or cell number, written 856-256-5083: the team only.
  -- Numbers without all ten digits are left out.
  SELECT entity_uid,
         REGEXP_REPLACE(digits, '^(\\d{3})(\\d{3})(\\d{4})$', '\\1-\\2-\\3')
           || CASE WHEN phone_ext IS NOT NULL THEN ' x' || phone_ext END AS phone,
         ROW_NUMBER() OVER (PARTITION BY entity_uid
                            ORDER BY CASE phone_primary_ind WHEN 'Y' THEN 0 ELSE 1 END,
                                     phone_seq_number DESC) AS rn
    FROM (SELECT entity_uid, phone_ext, phone_primary_ind, phone_seq_number,
                 REGEXP_REPLACE(phone_number_combined, '[^0-9]') AS digits
            FROM odsmgr.telephone
           WHERE entity_uid IN (SELECT person_uid FROM team)
             AND REGEXP_LIKE(UPPER(phone_type_desc), 'OFFICE|BUSINESS|CAMPUS|WORK')
             AND NVL(phone_status_ind, 'A') <> 'I'
             AND NVL(phone_unlist_ind, 'N') <> 'Y')
   WHERE LENGTH(digits) = 10
)
SELECT n.full_name              AS "Name",
       t.position_title         AS "Title",
       t.home_organization_desc AS "Department",
       n.email                  AS "Email",
       p.phone                  AS "Phone",
       s.full_name              AS "Manager"
  FROM team t
  JOIN nm n         ON n.person_uid = t.person_uid
  LEFT JOIN nm s    ON s.person_uid = t.supervisor_uid
  LEFT JOIN phone p ON p.entity_uid = t.person_uid AND p.rn = 1
 ORDER BY "Department", "Name"
`
