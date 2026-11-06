import globals from "globals";

// All content scripts listed in manifest.json share one isolated world, so
// top-level declarations in one file are visible in the others (the offline
// page scripts in js/offline/ share scope the same way via offline.html).
// Symbols defined in one file and used from another are declared here.
const sharedNames = [
  // js/store
  "saveData",
  "getData",
  "saveMarksPage",
  "getMarksPage",
  "saveAttendancePage",
  "getAttendancePage",
  "saveExamSchedulePage",
  "getExamSchedulePage",
  "saveTimeTable",
  "getTimeTable",
  // js/utils
  "chooseCurrentSemester",
  "parseSemesterStart",
  "attendanceHasData",
  "semesterFallbackOrder",
  "currentTermStartEstimate",
  "semesterLooksStale",
  "filterRepeated",
  "filterRepeatedColumns",
  // js/utils/safe_html.js
  "vrSafeHtml",
  // js/captcha
  "bitmaps",
  "fill_captcha",
  // js/modules/dom-to-image.js
  "domtoimage",
  // js/shared/ics.js — RFC 5545 helpers used by every .ics producer
  "vrIcs",
  // js/timetable
  "extract_header",
  "extract_lab_header",
  "extract_tbody_data",
  "extract_tr_data",
  "createTableHead",
  "createTr",
  "_create_td_element",
  "create_download_link",
  "getPlaceholder",
  "getBlockText",
  "getCourseCode",
  "addBlocks",
  "change_time_table",
  // js/offline
  "createMenu",
  "createTable",
  "displayTableData",
  "insertTable",
];

const sharedGlobals = Object.fromEntries(
  sharedNames.map((name) => [name, "readonly"])
);

const sharedRules = {
  "no-undef": "error",
  "no-unused-vars": [
    "warn",
    {
      args: "none",
      caughtErrors: "none",
      varsIgnorePattern: `^(${sharedNames.join("|")})$`,
    },
  ],
  // builtinGlobals off so defining a shared symbol in its home file is fine
  "no-redeclare": ["error", { builtinGlobals: false }],
  // A `const` read above its own declaration in the same block is a
  // ReferenceError at runtime, and nothing else here catches it: it type
  // -checks, it lints, and the tests pass, because the throw only happens on
  // the one branch that reads it early. That is exactly how the OTP panel
  // came to report "Extension error" whenever no mail tab was open.
  // functions/classes stay off — hoisted declarations used earlier in a file
  // are the established style across these scripts.
  //
  // "warn", not "error": the rule cannot tell a straight-line read (always a
  // throw) from a reference inside a callback that only runs later (always
  // fine), and all twelve pre-existing hits are the latter — mutually
  // recursive `const` arrows, a removeListener naming its own handler. Those
  // are not worth rewriting, so failing CI on them would just get the rule
  // deleted. A warning still puts the next one in front of whoever added it.
  "no-use-before-define": [
    "warn",
    { functions: false, classes: false, variables: true },
  ],
};

export default [
  {
    ignores: ["js/modules/**", "js/captcha/bitmaps.js", "node_modules/**"],
  },
  {
    files: ["js/**/*.js", "service_worker/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        ...sharedGlobals,
      },
    },
    rules: sharedRules,
  },
  {
    // Runs in the VTOP page context (injected via <script>), where the
    // page's jQuery and helpers exist.
    files: ["js/outing/store.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        ...globals.browser,
        ...globals.jquery,
        getnumber: "readonly",
      },
    },
    rules: sharedRules,
  },
];
