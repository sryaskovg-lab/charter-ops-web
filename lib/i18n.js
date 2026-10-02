"use client";
// ---------- i18n ----------
// A deliberately small, hand-rolled translation layer — no external library, because the app
// only needs two languages and a lookup-by-key dictionary. Scope: English + Russian across
// Dashboard, Schedule (the Gantt + Draft mode + Issues panel), Aircraft, Tour operators, Team,
// Reports, and the flight drawer's seats/allotment section. The Slots tab, slot-request/ATFM
// cards inside the flight drawer, and SCR message generation/wording are deliberately left in
// English everywhere — that's IATA SSIM / ops-coordination terminology exchanged with external
// parties (airports, handlers), not app chrome, and mistranslating it is a real operational risk.
//
// Any component that needs text calls useLanguage() directly (React context) rather than having
// `t` threaded through props across the whole tree.
import React, { createContext, useContext, useState, useEffect, useCallback } from "react";

export const translations = {
  en: {
    // ----- nav / shell -----
    nav_dashboard: "Dashboard", nav_schedule: "Schedule", nav_aircraft: "Aircraft",
    nav_operators: "Tour operators", nav_slots: "Slots", nav_team: "Team",
    synced: "Synced", offline: "Offline", signOut: "Sign out", menu: "Menu",
    searchPlaceholder: "Search flights, routes, operators…", searchPlaceholderShort: "Search…",
    noMatches: "No matches.", tourOperatorTag: "tour operator",
    notifications: "Notifications", notificationsEmpty: "Nothing yet — actions across the app show up here.",
    collapseSidebar: "Collapse sidebar", expandSidebar: "Expand sidebar", closeMenu: "Close menu",
    loadingShared: "Loading shared schedule…",

    // ----- schedule board toolbar -----
    viewDay: "Day", viewPeriod: "Period", today: "Today", dateRangeTo: "to",
    filterPlaceholder: "Filter (ref, route)…", localTime: "Local time", utc: "UTC",
    issues: "Issues", draftModeOn: "Draft mode: ON", draftModeOff: "Draft mode: OFF",
    draftChangesCount: "Draft changes", more: "More ▾", generateScr: "Generate SCR",
    generateRotation: "Generate rotation", schedulingEngine: "Scheduling engine",
    bulkImport: "Bulk import", bulkRetime: "Bulk retime", bulkDelete: "Bulk delete",
    newFlight: "+ New flight", showLocalTimeNote: "Showing each flight's departure/arrival in its own station's local time. \"?\" means that station isn't in the timezone table yet.",
    noMatchesFilter: (q) => `Nothing matches "${q}". Try a flight number or a 3-4 letter airport code.`,
    aircraftColHeader: "Aircraft", upToFlightsPerDay: (n) => `up to ${n} flights/day`,
    legendHealthy: "Healthy fill", legendNearFull: "Near full (≥92%)", legendOversold: "Oversold",
    legendDraft: "Dashed → pending draft (click to review)",
    showDestColors: "Show destination colors", hideDestColors: "Hide destination colors",
    movingFlightHint: (ref) => `Moving ${ref} — release over a day to drop`,
    newFlightHere: "+ New flight here", duplicateNextDay: "Duplicate → next day", delete: "Delete",
    color: "Color", readOnlyRole: "Read-only for your role",
    flightsSelected: (n) => `${n} flight${n === 1 ? "" : "s"} selected`, clear: "Clear",
    deleteFlightsSelectedConfirm: (n) => `Delete ${n} selected flight(s)? This can't be undone.`,
    deleteFlightRefConfirm: (ref) => `Delete ${ref}? This can't be undone.`,

    // ----- issues panel -----
    issuesSubtitle: "Turnaround, routing, capacity, double-booking — advisory only, nothing here is blocked.",
    activeTab: (n) => `Active (${n})`, acknowledgedTab: (n) => `Acknowledged (${n})`,
    noOutstandingIssues: "Nothing outstanding — every issue is either resolved or acknowledged.",
    noAcknowledgedIssues: "No acknowledged issues.", acknowledge: "Acknowledge",

    // ----- draft panel -----
    draftPanelSubtitle: "Queued while Draft mode is on — nothing here is live until you approve it.",
    approveAll: (n) => `Approve all (${n})`, discardAll: "Discard all",
    discardAllConfirm: (n) => `Discard all ${n} pending draft changes? This can't be undone.`,
    noPendingDrafts: "No pending draft changes.", approve: "Approve", discard: "Discard",

    // ----- flight drawer -----
    flightInfo: "Flight info", seats: "Seats", price: "Price", addSeats: "+ Add seats",
    allotments: "Allotments", capacity: "Capacity", allocated: "Allocated", unsold: "Unsold",
    oversoldBy: (n) => `Oversold by ${n}`, revenue: "Revenue",
    noAllotmentsYet: "No tour operator allotments on this flight yet.",
    deleteFlightConfirm: "Delete this flight? This can't be undone.",
    confirmTimeChange: "Confirm time change", revert: "Revert", depTime: "Departure", arrTime: "Arrival",
    origin: "Origin", destination: "Destination", status: "Status", close: "Close",
    fieldRoute: "Route", fieldDate: "Date", fieldDepArrUtc: "Departs / arrives (UTC)", fieldAircraft: "Aircraft",
    fieldCapacity: "Capacity", fieldBoxColor: "Box color", useStatusColor: "Use status color",
    localTimePrefix: "Local:", deleteThisFlight: "Delete this flight",
    deleteFlightWithAllotmentsWarn: (n) => `This flight has ${n} active allotment(s) — deleting it removes those too. This can't be undone.`,
    cantUndo: "This can't be undone.", cancel: "Cancel", confirmDelete: "Confirm delete",
    miniStatCapacity: "Capacity", miniStatAllocated: "Allocated", miniStatUnsold: "Unsold",
    oversoldBySeatsWarn: (n) => `Oversold by ${n} seats — reduce an allotment below or increase capacity.`,
    estRevenue: "Est. revenue on this flight:", noSeatsAllocatedYet: "No seats allocated yet.",
    released: "RELEASED", autoReleases: (d) => `Auto-releases ${d} if not confirmed`,
    addAllotment: "Add allotment", seatsTitle: "Seats", pricePerSeatThisFlight: "Price/seat for this flight",
    pricePerSeatTitle: "Price per seat, this flight only",
    defaultsToRate: (name, dest) => `Defaults to ${name}'s rate to ${dest} — override it here without changing their rate table.`,
    allotmentEditLimited: "Allotment editing is limited to commercial staff, liaisons, and management.",
    allotmentTypeFirm: "FIRM", allotmentTypeOption: "OPTION",
    samePriceCantReduce: "same price · can't reduce",

    // ----- tour operators tab -----
    tourOperators: "Tour operators", addOperator: "+ Add operator", operatorName: "Name",
    country: "Country", defaultRate: "Default rate / seat", allotmentType: "Allotment type",
    optionReleaseDays: "Option release (days)", releaseSeatsBtn: "Release seats",
    releaseSeatsPanelTitle: "Release seats", releaseSeatsSubtitle: "Pick flights and how many seats to give back per flight — full or partial. This is the only way an allotment can go down.",
    selectAll: "Select all", releaseConfirm: (seats, n) => `Release ${seats} seat${seats === 1 ? "" : "s"} across ${n} allotment${n === 1 ? "" : "s"}?`,
    allocateSeats: "Allocate seats", searchFlightRoute: "Search flight or route…",
    noFlightsFound: "No flights found.", add: "Add", seatsCol: "Seats", priceCol: "Price / seat",
    totalRevenueCol: "Revenue", activeAllotmentsTab: "Active allotments", noActiveAllotments: "No active allotments yet.",
    deleteOperatorConfirm: (name) => `Delete ${name}? This can't be undone.`,
    bulkImportOperators: "Bulk import operators", newOperator: "+ New operator",
    thOperator: "Tour operator", thDefaultRate: "Default rate", thAllotmentType: "Allotment type",
    thStatus: "Status", thSeats: "Seats", thValue: "Value",
    none: "none", clearDefaultRateTitle: "Clear default rate — every allotment for this operator will then need its own explicit price",
    hide: "Hide", allocateSeatsBtn: "Allocate seats", viewSeatsBtn: "View seats", releaseSeatsRowBtn: "Release seats",
    confirm: "Confirm",
    allocateSeatsExplain: (name) => `Allocate seats directly against specific flights for ${name} — search by flight number or route (e.g. "CIT-HRI"), pick one or several matching dates, set seats and price, then Add. This creates real allotments, the same ones the Schedule board and this operator's "View seats" below both show — editing a flight's allotment either place updates both. If ${name} already has seats on a picked flight, this tops up that allocation at its existing price instead of the price typed below — allocated seats can never be reduced or repriced, only added to.`,
    flightRouteSearchPlaceholder: "Flight number or route (e.g. AD-AA)…",
    noFlightsMatchQuery: (q) => `No flights match "${q}".`,
    selectAllN: (n) => `Select all ${n}`, fieldSeats: "Seats", fieldPricePerSeat: "Price / seat ($)",
    addCount: (n) => n ? `Add (${n})` : "Add",
    noActiveAllotments2: "No active allotments.",
    allActiveAllotmentsFor: (name) => `All active allotments for ${name} — one consolidated view instead of a separate tab per flight:`,
    releaseExplain: (name) => `Release unsold seats for ${name} back to inventory — pick the flight(s), set how many seats to give back on each (the full amount by default, or less for a partial release), confirm, and those seats become available to allocate to anyone again. This is separate from the no-reduction rule above: it's a deliberate hand-back, not a quiet edit.`,
    noActiveAllotmentsToRelease: "No active allotments to release.",
    ofSeatsAt: (total, price) => `of ${total} @ $${price}`, releaseWord: "release",
    releaseSummary: (seats, n) => `${seats} seats across ${n} flight(s)`,
    releaseEllipsis: "Release…", giveBackForGood: (n) => `Give back ${n} seats for good?`,
    confirmRelease2: "Confirm release",
    newTourOperator: "New tour operator", fieldName: "Name", fieldCountry: "Country",
    fieldDefaultRatePerSeat: "Default rate / seat ($)", fixed: "Fixed", option: "Option",
    optionReleaseDaysBefore: "Option release (days before)", active: "Active", onHold: "On hold", blacklisted: "Blacklisted",
    perDestNote: "Per-route rates can be added afterward from the \"Route rates\" panel on this operator's row.",
    routeRatesBtn: "Route rates",
    routeRatesExplain: (name) => `The $/seat ${name} is charged on each route. This is the standing rate card — set it here once and every future allocation (single or bulk-imported) for that exact route uses it automatically; it never resets or gets overwritten by an import unless you change it here.`,
    noRouteRatesYet: "No route rates set yet — allocations use the default rate above until one's added here.",
    removeRouteRate: "Remove this route's rate — allocations on it fall back to the default rate",
    fieldRoute: "Route", routeCodePlaceholder: "e.g. ALA-PQC",
    techStopRouteHint: "For a tech-stop journey (e.g. ALA-DMB-SYX), enter all the codes in order — the same price is set on each leg (ALA-DMB and DMB-SYX), since each leg is its own flight with its own allotments.",
    create: "Create", bulkImportOperatorsTitle: "Bulk import tour operators",
    bulkImportOperatorsExplain: "One row per operator sets the default rate (leave destination blank); add one more row per operator for each destination-specific rate. Nothing is written until you commit below.",
    preview: "Preview", colName: "Name", colCountry: "Country", colDefault: "Default", colDestRates: "Dest. rates",
    rowsSelected: (ok, total) => `${ok} of ${total} rows selected`, back: "Back",
    importN: (n) => `Import ${n}`,

    bulkImportAllotments: "Bulk import allotments",
    bulkImportAllotmentsTitle: "Bulk import tour-operator allotments",
    bulkImportAllotmentsExplain: "Upload the route/allotment matrix workbook. Each row expands into every matching date in its period and is matched against flights already on the board — only matched rows ever get written. Unmatched rows (no flight on that date) are listed for manual review and never block the rest. Operator names not yet in the system are created automatically with default terms, editable afterward.",
    chooseExcelFile: "Choose Excel file…", parsingEllipsis: "Parsing…",
    colFlight: "Flight", colDate: "Date", colOperator: "Operator", colSeats: "Seats", colMatchStatus: "Match",
    matchedStatus: "Matched", unmatchedStatus: "No flight found", newOperatorStatus: "New operator",
    defaultTypeForImport: "Allotment type for these allocations",
    pricePerRouteTitle: "Price per seat by route",
    pricePerRouteExplain: "Optional. The sheet carries no prices, so this fills in one $/seat per route — but only for an operator that doesn't already have its own rate for that route (their existing rate always wins and stays untouched). Left blank, the operator's flat default rate applies instead. Any gap filled here is saved to that operator's route rates going forward, not just used for this import.",
    manualReviewRows: (n) => `${n} row${n === 1 ? "" : "s"} couldn't be parsed and need manual review:`,
    rowLabel: "Row",
    unmatchedRowsNote: (n) => `${n} allocation${n === 1 ? "" : "s"} have no matching flight on that date — they'll be skipped.`,
    newOperatorsNote: (n, names) => `${n} new operator${n === 1 ? "" : "s"} will be created: ${names}.`,
    importSummary: (matched, unmatched, newOps) => `${matched} allocation${matched === 1 ? "" : "s"} ready to import${unmatched ? `, ${unmatched} skipped (no matching flight)` : ""}${newOps ? `, ${newOps} new operator${newOps === 1 ? "" : "s"}` : ""}`,
    importAllotmentsN: (n) => `Import ${n} allocation${n === 1 ? "" : "s"}`,
    noAllotmentRowsFound: "No recognizable allocation rows found in this file. Check that it's the route/allotment matrix workbook with a \"№ рейса\" header row.",

    // ----- team tab -----
    team: "Team", addUser: "+ Add user", role: "Role", email: "Email", name: "Name",
    resetPassword: "Reset password", deleteUser: "Delete user",
    deleteUserConfirm: (name) => `Delete ${name}? This can't be undone.`,
    tempPasswordNote: (pw) => `Temp password: ${pw} (copy it now — this won't be shown again)`,
    rolesGateNote: "Roles here are what actually gate permissions everywhere else in the app — not a display label.",
    addTeammate: "+ Add teammate", thName: "Name", thEmail: "Email", thRole: "Role",
    youSuffix: "(you)", resetPasswordBtn: "Reset password",
    newTempPasswordToast: (email, pw) => `New temp password for ${email}: ${pw} (copy it now — this won't be shown again)`,
    askAnotherManager: "Ask another manager to change your own role",
    confirmDeleteBtn: "Confirm delete",
    addTeammateTitle: "Add a teammate", fieldEmail: "Email", fieldRole: "Role",
    createLoginNote: "Creates the login directly with a temporary password (no email needs to be configured) — you'll see it once after creating, to relay to them yourself.",
    createdUserToast: (email, pw) => `${email} created — temp password: ${pw} (copy it now — this won't be shown again)`,
    tasksTitle: "Tasks", openCount: (n) => `${n} open`, noTasksYet: "No tasks yet.",
    roleCommercial: "Commercial staff", roleLiaison: "Tour operator liaison",
    roleOpsCoordinator: "Schedule coordinator (ops)", roleManagement: "Charter dept management",
    routeMap: "Route map", live: "LIVE", scheduledRoute: "Scheduled route",
    activeRoutesStations: (routes, stations) => `${routes} active route${routes === 1 ? "" : "s"} · ${stations} stations`,
    notYetPlotted: (codes) => `Not yet plotted: ${codes} (no IATA match in the worldwide airport list)`,
    charterOperations: "Charter Operations", planCoordinateDeliver: "Plan · Coordinate · Deliver",
    kpiTotalFlights: "Total flights", kpiOnTheBoard: "On the board", kpiSeatsSold: "Seats sold",
    kpiActiveConfirmed: "Active + confirmed", kpiLoadFactor: "Load factor", kpiSoldCapacity: "Sold ÷ capacity",
    kpiTourOperators: "Tour operators", kpiActive: "Active", revenueOnBoard: "Revenue on board",
    tabUpcomingFlights: "Upcoming flights", tabRecentFlights: "Recent flights", tabAircraftStatus: "Aircraft status",
    thDate: "Date", thFlight: "Flight", thRoute: "Route", thAircraft: "Aircraft", thVariant: "Variant",
    nothingHere: "Nothing here.", statusActive: "ACTIVE",
    statusScheduled: "Scheduled", statusConfirmed: "Confirmed", statusOperating: "Operating", statusCancelled: "Cancelled",
    recentNotifications: "Recent notifications", notificationsWillShow: "Actions across the app will show up here.",
    showingScope: (scope) => `Showing scope: ${scope}. Management sees fleet-wide financials.`,

    // ----- aircraft tab (extra) -----
    thRegistration: "Registration", thCapacity: "Capacity",
    thFlightsOnBoard: "Flights on board", removeBtn: "Remove",
    maintenanceSchedule: "Maintenance schedule", addBlock: "+ Add block",
    thAircraftCol: "Aircraft", thFrom: "From", thTo: "To", thReason: "Reason",
    noMaintenanceBlocks: "No maintenance blocks scheduled. Aircraft here are treated as available every day.",
    addMaintenanceBlockTitle: "Add maintenance block",
    addMaintenanceBlockSubtitle: "This aircraft is treated as unavailable for the whole span, inclusive of both dates — the scheduling engine and conflict checks respect it.",
    fieldReasonOptional: "Reason (optional)", addBlockBtn: "Add block", addAircraftTitle: "Add aircraft",
    fieldRegistration: "Registration",

    // ----- dashboard -----
    tasks: "Tasks", addTaskPlaceholder: "Add a task…", fleetUtilization: "Fleet utilization",
    recentActivity: "Recent activity", openReports: "Open reports",

    // ----- aircraft tab -----
    aircraft: "Aircraft", addAircraft: "+ Add aircraft", variant: "Variant",
    maintenance: "Maintenance", addMaintenanceBlock: "+ Add maintenance block",

    // ----- reports -----
    reports: "Reports", generateReport: "Generate report", dateRange: "Date range", sections: "Sections",
    downloadPdf: "Download PDF", emailReport: "Email report",

    // ----- toasts (generic) -----
    flightUpdated: "Flight updated — all attached allotments now read the new values",
    updateFailed: (msg) => `Update failed: ${msg}`,
    depShort: "dep ", arrShort: "arr ", seatsSold: (a, c) => `${a}/${c} seats sold`,
    oversoldBySuffix: (n) => ` · oversold by ${n}`, unknownOperator: "Unknown operator",

    // ----- new flight modal (non-SCR fields only) -----
    newFlightTitle: "New flight", newFlightSubtitle: "Fill this in, generate the slot request first, then confirm to put it on the schedule.",
    fieldFlightNumber: "Flight number", fieldOrigin: "Origin", fieldDestination: "Destination",
    fieldDepartureUtc: "Departure (UTC)", fieldArrivalUtc: "Arrival (UTC)",
    conflictHeadsUp: (code, ref, date) => `Heads up: ${code} already flies ${ref} on ${date}. You can still add this one — just flagging it.`,

    // ----- bulk import modal -----
    bulkImportTitle: "Bulk import flights",
    tabPasteCsv: "Paste CSV rows", tabUploadExcel: "Upload Excel roster",
    pasteCsvDescription: "Paste rows in the same shape as the roster grid: flight number, route, times, aircraft, and leg type (revenue vs. ferry/positioning). Recurring weekly rows get grouped into a pattern automatically. Nothing is written until you commit at the end.",
    excelUploadDescription: "Upload the actual roster workbook — one sheet per tail number, flight number and route in adjacent cells under each weekday column. Sheets that don't match a tail in your fleet (summary sheets, aircraft not in the fleet list) are skipped and listed below, not silently dropped. Nothing is written until you commit at the end.",
    readingWorkbook: "Reading workbook…",
    noRecognizableRows: "No recognizable flight rows found. Check that this is the roster-grid workbook (one sheet per tail number) and that the sheet names include the tail's registration digits.",
    couldNotReadFile: (msg) => `Could not read this file: ${msg}`,
    parsedFilePrefix: "Parsed", skippedSheetsPrefix: "Skipped sheets (no matching aircraft in fleet):",
    annotationsFoundNote: (n) => `${n} non-flight annotation${n === 1 ? "" : "s"} (tour-operator labels, NOTAMs, etc.) found and left out — informational only, not imported.`,
    detectedPatterns: "Detected recurring patterns", occurrencesRotationTemplate: (n) => `${n} occurrence${n === 1 ? "" : "s"} → rotation template`,
    individualRows: "Individual rows", thFlt: "Flt", thAc: "A/C", thLeg: "Leg",
    patternsAndRowsSummary: (pc, flightsN, rowN) => `${pc} pattern${pc === 1 ? "" : "s"} (${flightsN} flights) + ${rowN} individual row${rowN === 1 ? "" : "s"} selected`,

    // ----- scheduling / rotation / bulk retime / bulk delete modals -----
    schedulingEngineTitle: "Scheduling engine", rotationGenTitle: "Generate rotation",
    bulkRetimeTitle: "Bulk retime", bulkDeleteTitle: "Bulk delete",
    apply: "Apply", applyN: (n) => `Apply (${n})`, deleteN: (n) => `Delete (${n})`,
    selectFlights: "Select flights", noFlightsMatch: "No flights match.",
    schedulingEngineDescription: "Define the routes you need covered. The engine fills in aircraft automatically — avoiding double-booking and respecting maintenance downtime — and spreads the load evenly across whatever's eligible. It's a greedy fill processed in date order, not a global optimizer: it won't rearrange an earlier assignment to make a later requirement fit better.",
    addAnotherRoute: "+ Add another route", generateSchedule: "Generate schedule",
    statusAssigned: "ASSIGNED", statusUnassigned: "UNASSIGNED",
    assignableSummary: (n, u) => `${n} assignable${u > 0 ? `, ${u} couldn't be assigned` : ""}`,

    // ----- requirement row (scheduling engine route builder) -----
    fieldAircraftType: "Aircraft type", anyAvailable: "Any available",
    fieldReturnFlightNumber: "Return flight number", fieldReturnDepartsUtc: "Return departs (UTC)",
    fieldReturnArrivesUtc: "Return arrives (UTC)", fieldDaysAfterOutbound: "Days after outbound",
    roundTripLabel: (dest, orig) => `Round trip — add a return leg (${dest} → ${orig})`,
    sameDayTurnaroundNote: (dest) => `0 = same-day turnaround at ${dest}. The same aircraft flies both legs — the engine won't assign the outbound to one tail and the return to another.`,
    dateModeDaysOfWeek: "Days of week", dateModeEveryNDays: "Every N days", dateModePickDates: "Pick dates",
    fieldStartDate: "Start date", fieldEndDate: "End date", fieldEveryNDays: "Every N days",
    repeatsEveryNote: (n, start, end) => `Repeats every ${n} day${n === 1 ? "" : "s"} starting ${start}, through ${end} — not tied to weekdays.`,
    removeRoute: "Remove route",

    // ----- rotation generator modal -----
    rotationGenDescription: "Define the weekly pattern once — every matching date previews here before anything is written.",
    outboundLegHeader: (o, d) => `Outbound leg — ${o}→${d}`,
    alsoGenerateReturn: "Also generate the return leg", returnLegHeader: "Return leg",
    returnLegNote: "Doesn't have to go back the way it came — e.g. CIT→VKO out, VKO→ALA back. Leave blank to default to the reverse of the outbound route.",
    fieldReturnAfterDays: "Return after (days)",
    returnOffsetNote: "0 = same day (typical out-and-back turnaround). Use 1+ for layovers — e.g. 1 means the aircraft returns the day after each outbound date.",
    previewDates: "Preview dates", reviewSlotRequestNote: "Review, then generate the slot request before anything is written to the schedule.",
    legOutbound: "Outbound", legReturn: "Return",

    // ----- bulk delete modal -----
    bulkDeleteDescription: "Filter to the flights you want gone, review exactly what's affected, then commit. This can't be undone.",
    fieldFrom: "From", fieldTo: "To", allAircraft: "All aircraft",
    fieldOriginContains: "Origin contains", fieldDestContains: "Dest. contains",
    thRef: "Ref", thActiveAllotments: "Active allotments", noFlightsMatchedFilter: "No flights matched that filter.",
    activeAllotmentsWillBeDeleted: (n) => `${n} active allotment${n === 1 ? "" : "s"} across the selected flights will be deleted too.`,
    flightsOfSelected: (n, total) => `${n} of ${total} flights selected`,
    deleteCountBtn: (n) => `Delete ${n}`,

    // ----- bulk retime modal -----
    bulkRetimeDescription: "Shift dates and/or times across a whole season (or any filtered set) in one go. Nothing changes until you commit below.",
    whichFlights: "Which flights", thisSeason: (s) => `This season (${s})`,
    whatChanges: "What changes", fieldShiftDateByDays: "Shift date by (days)",
    fieldTimeChange: "Time change", timeChangeNone: "No time change",
    timeChangeShift: "Shift by minutes (e.g. clock change)", timeChangeSet: "Set new departure time",
    fieldMinutesShift: "Minutes (+/-)", fieldNewDepartureUtc: "New departure (UTC)",
    arrivalMovesWithDeparture: "Arrival time moves with departure so each flight's duration stays the same.",
    thCurrent: "Current", thNew: "New", applyToCountBtn: (n) => `Apply to ${n}`,

    // ----- reports modal -----
    reportsDescription: "Pick a date range and whichever sections you need — one combined PDF, download or email it directly.",
    sectionsLabel: "Sections", generating: "Generating…", orEmailDirectly: "Or email it directly",
    sendBtn: "Send", sending: "Sending…",
    pickSectionFirst: "Pick at least one section first", enterRecipientFirst: "Enter a recipient email first",
    reportEmailedTo: (email) => `Report emailed to ${email}`,
    reportSectionSchedule: "Schedule (flights)", reportSectionRevenue: "Revenue",
    reportSectionAllotments: "Tour operator allotments", reportSectionUtilization: "Fleet utilization",
    reportSectionIssues: "Schedule issues", reportSectionScrArchive: "SCR message archive",

    // ----- reports modal -----
    reportsTitle: "Reports",
  },
  ru: {
    nav_dashboard: "Дашборд", nav_schedule: "Расписание", nav_aircraft: "Флот",
    nav_operators: "Туроператоры", nav_slots: "Слоты", nav_team: "Команда",
    synced: "Синхронизировано", offline: "Нет связи", signOut: "Выйти", menu: "Меню",
    searchPlaceholder: "Поиск рейсов, маршрутов, операторов…", searchPlaceholderShort: "Поиск…",
    noMatches: "Совпадений не найдено.", tourOperatorTag: "туроператор",
    notifications: "Уведомления", notificationsEmpty: "Пока пусто — действия в системе будут появляться здесь.",
    collapseSidebar: "Свернуть панель", expandSidebar: "Развернуть панель", closeMenu: "Закрыть меню",
    loadingShared: "Загрузка общего расписания…",

    viewDay: "День", viewPeriod: "Период", today: "Сегодня", dateRangeTo: "по",
    filterPlaceholder: "Фильтр (№ рейса, маршрут)…", localTime: "Местное время", utc: "UTC",
    issues: "Проблемы", draftModeOn: "Черновик: ВКЛ", draftModeOff: "Черновик: ВЫКЛ",
    draftChangesCount: "Черновые изменения", more: "Ещё ▾", generateScr: "Generate SCR",
    generateRotation: "Сгенерировать ротацию", schedulingEngine: "Планировщик",
    bulkImport: "Массовый импорт", bulkRetime: "Массовый перенос времени", bulkDelete: "Массовое удаление",
    newFlight: "+ Новый рейс", showLocalTimeNote: "Вылет/прилёт каждого рейса показан в местном времени аэропорта. «?» значит, что аэропорт ещё не в таблице часовых поясов.",
    noMatchesFilter: (q) => `Ничего не найдено по запросу «${q}». Попробуйте номер рейса или код аэропорта (3-4 буквы).`,
    aircraftColHeader: "Борт", upToFlightsPerDay: (n) => `до ${n} рейсов в день`,
    legendHealthy: "Хорошая загрузка", legendNearFull: "Почти заполнен (≥92%)", legendOversold: "Перепродан",
    legendDraft: "Штрих → черновое изменение (нажмите, чтобы рассмотреть)",
    showDestColors: "Показать цвета направлений", hideDestColors: "Скрыть цвета направлений",
    movingFlightHint: (ref) => `Перенос ${ref} — отпустите над днём, чтобы переместить`,
    newFlightHere: "+ Новый рейс здесь", duplicateNextDay: "Дублировать → на следующий день", delete: "Удалить",
    color: "Цвет", readOnlyRole: "Только просмотр для вашей роли",
    flightsSelected: (n) => `Выбрано рейсов: ${n}`, clear: "Очистить",
    deleteFlightsSelectedConfirm: (n) => `Удалить ${n} выбранных рейсов? Это нельзя отменить.`,
    deleteFlightRefConfirm: (ref) => `Удалить рейс ${ref}? Это нельзя отменить.`,

    issuesSubtitle: "Разворот, маршрутизация, вместимость, пересечение рейсов — только рекомендации, ничего не блокируется.",
    activeTab: (n) => `Активные (${n})`, acknowledgedTab: (n) => `Подтверждённые (${n})`,
    noOutstandingIssues: "Нет нерешённых проблем — все решены либо подтверждены.",
    noAcknowledgedIssues: "Нет подтверждённых проблем.", acknowledge: "Подтвердить",

    draftPanelSubtitle: "В очереди, пока включён режим черновика — ничего не применяется, пока вы не подтвердите.",
    approveAll: (n) => `Подтвердить все (${n})`, discardAll: "Отклонить все",
    discardAllConfirm: (n) => `Отклонить все ${n} черновых изменений? Это нельзя отменить.`,
    noPendingDrafts: "Нет черновых изменений.", approve: "Подтвердить", discard: "Отклонить",

    flightInfo: "Информация о рейсе", seats: "Места", price: "Цена", addSeats: "+ Добавить места",
    allotments: "Квоты", capacity: "Вместимость", allocated: "Выделено", unsold: "Непродано",
    oversoldBy: (n) => `Перепродано на ${n}`, revenue: "Выручка",
    noAllotmentsYet: "На этом рейсе пока нет квот туроператоров.",
    deleteFlightConfirm: "Удалить этот рейс? Это нельзя отменить.",
    confirmTimeChange: "Подтвердить изменение времени", revert: "Вернуть", depTime: "Вылет", arrTime: "Прилёт",
    origin: "Откуда", destination: "Куда", status: "Статус", close: "Закрыть",
    fieldRoute: "Маршрут", fieldDate: "Дата", fieldDepArrUtc: "Вылет / прилёт (UTC)", fieldAircraft: "Борт",
    fieldCapacity: "Вместимость", fieldBoxColor: "Цвет блока", useStatusColor: "Цвет по статусу",
    localTimePrefix: "Местное:", deleteThisFlight: "Удалить рейс",
    deleteFlightWithAllotmentsWarn: (n) => `На этом рейсе ${n} активных квот(ы) — при удалении они тоже будут удалены. Это нельзя отменить.`,
    cantUndo: "Это нельзя отменить.", cancel: "Отмена", confirmDelete: "Подтвердить удаление",
    miniStatCapacity: "Вместимость", miniStatAllocated: "Выделено", miniStatUnsold: "Непродано",
    oversoldBySeatsWarn: (n) => `Перепродано на ${n} мест — уменьшите квоту ниже или увеличьте вместимость.`,
    estRevenue: "Ориент. выручка по рейсу:", noSeatsAllocatedYet: "Места пока не выделены.",
    released: "ОСВОБОЖДЕНО", autoReleases: (d) => `Авто-возврат ${d}, если не подтверждено`,
    addAllotment: "Добавить квоту", seatsTitle: "Места", pricePerSeatThisFlight: "Цена/место для этого рейса",
    pricePerSeatTitle: "Цена за место только для этого рейса",
    defaultsToRate: (name, dest) => `По умолчанию — тариф «${name}» до ${dest}; можно переопределить здесь без изменения их тарифной таблицы.`,
    allotmentEditLimited: "Редактирование квот доступно только коммерческому отделу, представителям операторов и руководству.",
    allotmentTypeFirm: "ЖЕСТКИЙ БЛОК", allotmentTypeOption: "МЯГКИЙ БЛОК",
    samePriceCantReduce: "та же цена · нельзя уменьшить",

    tourOperators: "Туроператоры", addOperator: "+ Добавить оператора", operatorName: "Название",
    country: "Страна", defaultRate: "Тариф по умолчанию / место", allotmentType: "Тип квоты",
    optionReleaseDays: "Опцион до релиза (дни)", releaseSeatsBtn: "Освободить места",
    releaseSeatsPanelTitle: "Освобождение мест", releaseSeatsSubtitle: "Выберите рейсы и количество мест для возврата по каждому — полностью или частично. Это единственный способ уменьшить квоту.",
    selectAll: "Выбрать все", releaseConfirm: (seats, n) => `Освободить ${seats} мест(а) по ${n} квот(ам)?`,
    allocateSeats: "Выделить места", searchFlightRoute: "Поиск рейса или маршрута…",
    noFlightsFound: "Рейсы не найдены.", add: "Добавить", seatsCol: "Места", priceCol: "Цена / место",
    totalRevenueCol: "Выручка", activeAllotmentsTab: "Активные квоты", noActiveAllotments: "Активных квот пока нет.",
    deleteOperatorConfirm: (name) => `Удалить ${name}? Это нельзя отменить.`,
    bulkImportOperators: "Массовый импорт операторов", newOperator: "+ Новый оператор",
    thOperator: "Туроператор", thDefaultRate: "Тариф по умолчанию", thAllotmentType: "Тип квоты",
    thStatus: "Статус", thSeats: "Места", thValue: "Сумма",
    none: "нет", clearDefaultRateTitle: "Сбросить тариф по умолчанию — тогда каждой квоте этого оператора потребуется своя явная цена",
    hide: "Скрыть", allocateSeatsBtn: "Выделить места", viewSeatsBtn: "Показать места", releaseSeatsRowBtn: "Освободить места",
    confirm: "Подтвердить",
    allocateSeatsExplain: (name) => `Выделите места напрямую по конкретным рейсам для «${name}» — найдите по номеру рейса или маршруту (например, «CIT-HRI»), выберите одну или несколько подходящих дат, укажите места и цену, затем нажмите «Добавить». Это создаёт реальные квоты — те же, что видны на табло расписания и в разделе «Показать места» этого оператора ниже — изменение квоты в любом месте обновляет обе. Если у «${name}» уже есть места на выбранном рейсе, это добавит их по уже действующей цене, а не по введённой ниже — выделенные места нельзя уменьшить или переоценить, только добавить.`,
    flightRouteSearchPlaceholder: "Номер рейса или маршрут (например, AD-AA)…",
    noFlightsMatchQuery: (q) => `Рейсы по запросу «${q}» не найдены.`,
    selectAllN: (n) => `Выбрать все (${n})`, fieldSeats: "Места", fieldPricePerSeat: "Цена / место ($)",
    addCount: (n) => n ? `Добавить (${n})` : "Добавить",
    noActiveAllotments2: "Активных квот нет.",
    allActiveAllotmentsFor: (name) => `Все активные квоты для «${name}» — единый список вместо отдельной вкладки на рейс:`,
    releaseExplain: (name) => `Освободите непродуманные места «${name}» обратно в оборот — выберите рейс(ы), укажите, сколько мест вернуть по каждому (по умолчанию — всё количество, либо меньше для частичного возврата), подтвердите — и эти места снова доступны для выделения кому угодно. Это отдельно от правила «нельзя уменьшать» выше: это осознанный возврат, а не тихая правка.`,
    noActiveAllotmentsToRelease: "Нет активных квот для освобождения.",
    ofSeatsAt: (total, price) => `из ${total} по $${price}`, releaseWord: "вернуть",
    releaseSummary: (seats, n) => `${seats} мест по ${n} рейс(ам)`,
    releaseEllipsis: "Освободить…", giveBackForGood: (n) => `Окончательно вернуть ${n} мест?`,
    confirmRelease2: "Подтвердить возврат",
    newTourOperator: "Новый туроператор", fieldName: "Название", fieldCountry: "Страна",
    fieldDefaultRatePerSeat: "Тариф по умолчанию / место ($)", fixed: "Фиксированный", option: "Опцион",
    optionReleaseDaysBefore: "Опцион до релиза (дней до вылета)", active: "Активен", onHold: "На удержании", blacklisted: "В чёрном списке",
    perDestNote: "Тарифы по маршрутам можно добавить позже в разделе «Тарифы по маршрутам» в строке этого оператора.",
    routeRatesBtn: "Тарифы по маршрутам",
    routeRatesExplain: (name) => `Цена $/место, которую платит «${name}» по каждому маршруту. Это постоянный тарифный справочник — задайте его здесь один раз, и каждое будущее выделение мест (вручную или массовым импортом) по этому маршруту будет использовать его автоматически; импорт не сбросит и не перезапишет его, если вы сами не измените тариф здесь.`,
    noRouteRatesYet: "Тарифы по маршрутам пока не заданы — выделения используют тариф по умолчанию выше, пока здесь не добавлен тариф.",
    removeRouteRate: "Удалить тариф по этому маршруту — выделения по нему вернутся к тарифу по умолчанию",
    fieldRoute: "Маршрут", routeCodePlaceholder: "напр. ALA-PQC",
    techStopRouteHint: "Для рейса с технической посадкой (напр. ALA-DMB-SYX) введите все коды по порядку — одна и та же цена будет установлена на каждом участке (ALA-DMB и DMB-SYX), поскольку каждый участок — это отдельный рейс со своими квотами.",
    create: "Создать", bulkImportOperatorsTitle: "Массовый импорт туроператоров",
    bulkImportOperatorsExplain: "Одна строка на оператора задаёт тариф по умолчанию (направление оставьте пустым); добавьте ещё строку на оператора для каждого тарифа по направлению. Ничего не записывается, пока вы не подтвердите ниже.",
    preview: "Предпросмотр", colName: "Название", colCountry: "Страна", colDefault: "По умолчанию", colDestRates: "Тарифы по направлениям",
    rowsSelected: (ok, total) => `Выбрано строк: ${ok} из ${total}`, back: "Назад",
    importN: (n) => `Импортировать (${n})`,

    bulkImportAllotments: "Массовый импорт квот",
    bulkImportAllotmentsTitle: "Массовый импорт квот туроператоров",
    bulkImportAllotmentsExplain: "Загрузите файл-матрицу рейсов и квот. Каждая строка раскрывается во все подходящие даты периода и сопоставляется с уже существующими рейсами на табло — записываются только совпавшие строки. Несовпавшие строки (нет рейса на эту дату) выводятся отдельно для ручной проверки и не блокируют остальные. Операторы, которых ещё нет в системе, создаются автоматически с условиями по умолчанию — их можно изменить позже.",
    chooseExcelFile: "Выбрать файл Excel…", parsingEllipsis: "Разбор файла…",
    colFlight: "Рейс", colDate: "Дата", colOperator: "Оператор", colSeats: "Места", colMatchStatus: "Совпадение",
    matchedStatus: "Совпал", unmatchedStatus: "Рейс не найден", newOperatorStatus: "Новый оператор",
    defaultTypeForImport: "Тип квоты для этих выделений",
    pricePerRouteTitle: "Цена за место по маршрутам",
    pricePerRouteExplain: "Необязательно. В файле нет цен, поэтому здесь можно задать цену $/место по маршруту — но только для оператора, у которого ещё нет своего тарифа на этот маршрут (его действующий тариф всегда остаётся как есть). Если оставить пустым, применяется обычный тариф по умолчанию этого оператора. Любой заполненный здесь тариф сохраняется у оператора на будущее, а не только для этого импорта.",
    manualReviewRows: (n) => `${n} строк(а) не разобраны и требуют ручной проверки:`,
    rowLabel: "Строка",
    unmatchedRowsNote: (n) => `${n} выделени(е/я/й) не нашли подходящий рейс на эту дату — они будут пропущены.`,
    newOperatorsNote: (n, names) => `Будет создано новых операторов: ${n} — ${names}.`,
    importSummary: (matched, unmatched, newOps) => `${matched} выделени(е/я/й) готово к импорту${unmatched ? `, ${unmatched} пропущено (рейс не найден)` : ""}${newOps ? `, ${newOps} новых операторов` : ""}`,
    importAllotmentsN: (n) => `Импортировать ${n} выделени(е/я/й)`,
    noAllotmentRowsFound: "В файле не найдено распознаваемых строк квот. Убедитесь, что это файл-матрица рейсов и квот со строкой заголовка «№ рейса».",

    team: "Команда", addUser: "+ Добавить пользователя", role: "Роль", email: "Email", name: "Имя",
    resetPassword: "Сбросить пароль", deleteUser: "Удалить пользователя",
    deleteUserConfirm: (name) => `Удалить ${name}? Это нельзя отменить.`,
    tempPasswordNote: (pw) => `Временный пароль: ${pw} (скопируйте сейчас — повторно он не будет показан)`,
    rolesGateNote: "Роли здесь реально управляют правами во всём приложении — это не просто подпись.",
    addTeammate: "+ Добавить сотрудника", thName: "Имя", thEmail: "Email", thRole: "Роль",
    youSuffix: "(вы)", resetPasswordBtn: "Сбросить пароль",
    newTempPasswordToast: (email, pw) => `Новый временный пароль для ${email}: ${pw} (скопируйте сейчас — повторно он не будет показан)`,
    askAnotherManager: "Попросите другого руководителя изменить вашу роль",
    confirmDeleteBtn: "Подтвердить удаление",
    addTeammateTitle: "Добавить сотрудника", fieldEmail: "Email", fieldRole: "Роль",
    createLoginNote: "Создаёт логин напрямую с временным паролем (настройка почты не требуется) — пароль будет показан один раз после создания, передайте его сотруднику сами.",
    createdUserToast: (email, pw) => `${email} создан — временный пароль: ${pw} (скопируйте сейчас — повторно он не будет показан)`,
    tasksTitle: "Задачи", openCount: (n) => `Открыто: ${n}`, noTasksYet: "Пока нет задач.",
    roleCommercial: "Коммерческий отдел", roleLiaison: "Представитель туроператора",
    roleOpsCoordinator: "Координатор расписания (ОЦП)", roleManagement: "Руководство отдела чартеров",
    routeMap: "Карта маршрутов", live: "ОНЛАЙН", scheduledRoute: "Запланированный маршрут",
    activeRoutesStations: (routes, stations) => `${routes} маршрут(ов) · ${stations} аэропортов`,
    notYetPlotted: (codes) => `Пока не нанесены: ${codes} (нет совпадения IATA в базе аэропортов)`,
    charterOperations: "Чартерные операции", planCoordinateDeliver: "Планируй · Координируй · Выполняй",
    kpiTotalFlights: "Всего рейсов", kpiOnTheBoard: "На табло", kpiSeatsSold: "Продано мест",
    kpiActiveConfirmed: "Активные + подтверждённые", kpiLoadFactor: "Загрузка", kpiSoldCapacity: "Продано ÷ вместимость",
    kpiTourOperators: "Туроператоры", kpiActive: "Активные", revenueOnBoard: "Выручка по рейсам",
    tabUpcomingFlights: "Ближайшие рейсы", tabRecentFlights: "Прошедшие рейсы", tabAircraftStatus: "Статус флота",
    thDate: "Дата", thFlight: "Рейс", thRoute: "Маршрут", thAircraft: "Борт", thVariant: "Тип",
    nothingHere: "Пока ничего нет.", statusActive: "АКТИВЕН",
    statusScheduled: "Запланирован", statusConfirmed: "Подтверждён", statusOperating: "Выполняется", statusCancelled: "Отменён",
    recentNotifications: "Последние уведомления", notificationsWillShow: "Действия в системе будут появляться здесь.",
    showingScope: (scope) => `Область видимости: ${scope}. Руководство видит финансы по всему флоту.`,

    // ----- aircraft tab (extra) -----
    thRegistration: "Регистрация", thCapacity: "Вместимость",
    thFlightsOnBoard: "Рейсов на борту", removeBtn: "Удалить",
    maintenanceSchedule: "График техобслуживания", addBlock: "+ Добавить блок",
    thAircraftCol: "Самолёт", thFrom: "С", thTo: "По", thReason: "Причина",
    noMaintenanceBlocks: "Блоки техобслуживания не запланированы. Самолёты считаются доступными каждый день.",
    addMaintenanceBlockTitle: "Добавить блок техобслуживания",
    addMaintenanceBlockSubtitle: "Этот самолёт считается недоступным на весь указанный период, включая обе даты — модуль планирования и проверки конфликтов это учитывают.",
    fieldReasonOptional: "Причина (необязательно)", addBlockBtn: "Добавить блок", addAircraftTitle: "Добавить самолёт",
    fieldRegistration: "Регистрация",

    tasks: "Задачи", addTaskPlaceholder: "Добавить задачу…", fleetUtilization: "Загрузка флота",
    recentActivity: "Последние действия", openReports: "Открыть отчёты",

    aircraft: "Флот", addAircraft: "+ Добавить борт", variant: "Тип",
    maintenance: "ТО", addMaintenanceBlock: "+ Добавить блок ТО",

    reports: "Отчёты", generateReport: "Сформировать отчёт", dateRange: "Период", sections: "Разделы",
    downloadPdf: "Скачать PDF", emailReport: "Отправить по email",

    flightUpdated: "Рейс обновлён — все привязанные квоты теперь отражают новые значения",
    updateFailed: (msg) => `Не удалось обновить: ${msg}`,
    depShort: "выл. ", arrShort: "приб. ", seatsSold: (a, c) => `${a}/${c} мест продано`,
    oversoldBySuffix: (n) => ` · перепродано на ${n}`, unknownOperator: "Неизвестный оператор",

    // ----- new flight modal (non-SCR fields only) -----
    newFlightTitle: "Новый рейс", newFlightSubtitle: "Заполните поля, сначала сформируйте слот-запрос, затем подтвердите добавление в расписание.",
    fieldFlightNumber: "Номер рейса", fieldOrigin: "Откуда", fieldDestination: "Куда",
    fieldDepartureUtc: "Вылет (UTC)", fieldArrivalUtc: "Прилёт (UTC)",
    conflictHeadsUp: (code, ref, date) => `Внимание: ${code} уже выполняет рейс ${ref} ${date}. Можно всё равно добавить этот — просто предупреждение.`,

    // ----- bulk import modal -----
    bulkImportTitle: "Массовый импорт рейсов",
    tabPasteCsv: "Вставить строки CSV", tabUploadExcel: "Загрузить Excel-расписание",
    pasteCsvDescription: "Вставьте строки в том же формате, что и сетка расписания: номер рейса, маршрут, время, самолёт и тип этапа (коммерческий или технический перелёт). Повторяющиеся еженедельные строки группируются в шаблон автоматически. Ничего не записывается до подтверждения в конце.",
    excelUploadDescription: "Загрузите реальный файл расписания — один лист на борт, номер рейса и маршрут в соседних ячейках под каждым днём недели. Листы, не соответствующие бортам вашего флота (сводные листы, самолёты не из списка), пропускаются и перечисляются ниже, а не отбрасываются молча. Ничего не записывается до подтверждения в конце.",
    readingWorkbook: "Чтение файла…",
    noRecognizableRows: "Не найдено распознаваемых строк рейсов. Убедитесь, что это файл расписания в сетке (один лист на борт) и что названия листов содержат цифры регистрации борта.",
    couldNotReadFile: (msg) => `Не удалось прочитать файл: ${msg}`,
    parsedFilePrefix: "Обработан файл", skippedSheetsPrefix: "Пропущенные листы (нет подходящего борта во флоте):",
    annotationsFoundNote: (n) => `Найдено и исключено ${n} нелётных пометок (метки туроператоров, NOTAM и т.п.) — только информационно, не импортируются.`,
    detectedPatterns: "Обнаруженные повторяющиеся шаблоны", occurrencesRotationTemplate: (n) => `${n} повторений → шаблон ротации`,
    individualRows: "Отдельные строки", thFlt: "Рейс", thAc: "Борт", thLeg: "Этап",
    patternsAndRowsSummary: (pc, flightsN, rowN) => `Выбрано шаблонов: ${pc} (рейсов: ${flightsN}) + отдельных строк: ${rowN}`,

    // ----- scheduling / rotation / bulk retime / bulk delete modals -----
    schedulingEngineTitle: "Модуль планирования", rotationGenTitle: "Сгенерировать ротацию",
    bulkRetimeTitle: "Массовое изменение времени", bulkDeleteTitle: "Массовое удаление",
    apply: "Применить", applyN: (n) => `Применить (${n})`, deleteN: (n) => `Удалить (${n})`,
    selectFlights: "Выбрать рейсы", noFlightsMatch: "Нет подходящих рейсов.",
    schedulingEngineDescription: "Опишите маршруты, которые нужно покрыть. Модуль автоматически подбирает самолёты — избегая двойного бронирования и учитывая простои на ТО — и равномерно распределяет нагрузку между доступными бортами. Это жадный алгоритм заполнения по датам, а не глобальный оптимизатор: он не станет пересматривать более раннее назначение, чтобы лучше вписать более позднее.",
    addAnotherRoute: "+ Добавить маршрут", generateSchedule: "Сформировать расписание",
    statusAssigned: "НАЗНАЧЕН", statusUnassigned: "НЕ НАЗНАЧЕН",
    assignableSummary: (n, u) => `Можно назначить: ${n}${u > 0 ? `, не удалось назначить: ${u}` : ""}`,

    // ----- requirement row (scheduling engine route builder) -----
    fieldAircraftType: "Тип самолёта", anyAvailable: "Любой доступный",
    fieldReturnFlightNumber: "Номер обратного рейса", fieldReturnDepartsUtc: "Вылет обратно (UTC)",
    fieldReturnArrivesUtc: "Прилёт обратно (UTC)", fieldDaysAfterOutbound: "Дней после вылета туда",
    roundTripLabel: (dest, orig) => `Туда-обратно — добавить обратный этап (${dest} → ${orig})`,
    sameDayTurnaroundNote: (dest) => `0 = разворот в тот же день в ${dest}. Оба этапа выполняет один и тот же самолёт — модуль не назначит рейс туда одному борту, а обратный другому.`,
    dateModeDaysOfWeek: "Дни недели", dateModeEveryNDays: "Каждые N дней", dateModePickDates: "Выбрать даты",
    fieldStartDate: "Дата начала", fieldEndDate: "Дата окончания", fieldEveryNDays: "Каждые N дней",
    repeatsEveryNote: (n, start, end) => `Повторяется каждые ${n} дней начиная с ${start} по ${end} — без привязки к дням недели.`,
    removeRoute: "Удалить маршрут",

    // ----- rotation generator modal -----
    rotationGenDescription: "Опишите недельный шаблон один раз — все подходящие даты появятся здесь в предпросмотре, прежде чем что-либо будет записано.",
    outboundLegHeader: (o, d) => `Рейс туда — ${o}→${d}`,
    alsoGenerateReturn: "Также сформировать обратный рейс", returnLegHeader: "Обратный рейс",
    returnLegNote: "Не обязательно возвращаться тем же маршрутом — например, CIT→VKO туда, VKO→ALA обратно. Оставьте пустым, чтобы использовать маршрут туда в обратном порядке.",
    fieldReturnAfterDays: "Обратно через (дней)",
    returnOffsetNote: "0 = в тот же день (обычный разворот туда-обратно). Используйте 1+ для стыковок — например, 1 означает возврат на следующий день после каждого вылета туда.",
    previewDates: "Предпросмотр дат", reviewSlotRequestNote: "Проверьте, затем сформируйте слот-запрос, прежде чем что-либо будет записано в расписание.",
    legOutbound: "Туда", legReturn: "Обратно",

    // ----- bulk delete modal -----
    bulkDeleteDescription: "Отфильтруйте рейсы, которые нужно удалить, проверьте, что именно затронуто, затем подтвердите. Это нельзя отменить.",
    fieldFrom: "С", fieldTo: "По", allAircraft: "Все самолёты",
    fieldOriginContains: "Откуда содержит", fieldDestContains: "Куда содержит",
    thRef: "Рейс", thActiveAllotments: "Активные квоты", noFlightsMatchedFilter: "По этому фильтру рейсов не найдено.",
    activeAllotmentsWillBeDeleted: (n) => `Будет также удалено активных квот: ${n} (по выбранным рейсам).`,
    flightsOfSelected: (n, total) => `Выбрано ${n} из ${total} рейсов`,
    deleteCountBtn: (n) => `Удалить ${n}`,

    // ----- bulk retime modal -----
    bulkRetimeDescription: "Сдвиньте даты и/или время сразу для целого сезона (или любой отфильтрованной выборки). Ничего не изменится до подтверждения ниже.",
    whichFlights: "Какие рейсы", thisSeason: (s) => `Этот сезон (${s})`,
    whatChanges: "Что изменится", fieldShiftDateByDays: "Сдвинуть дату на (дней)",
    fieldTimeChange: "Изменение времени", timeChangeNone: "Без изменения времени",
    timeChangeShift: "Сдвинуть на минуты (напр., переход времени)", timeChangeSet: "Задать новое время вылета",
    fieldMinutesShift: "Минуты (+/-)", fieldNewDepartureUtc: "Новый вылет (UTC)",
    arrivalMovesWithDeparture: "Время прилёта сдвигается вместе с вылетом, чтобы продолжительность рейса не менялась.",
    thCurrent: "Текущее", thNew: "Новое", applyToCountBtn: (n) => `Применить к ${n}`,

    // ----- reports modal -----
    reportsDescription: "Выберите период и нужные разделы — единый PDF, скачайте или отправьте по email прямо отсюда.",
    sectionsLabel: "Разделы", generating: "Формирование…", orEmailDirectly: "Или отправить по email",
    sendBtn: "Отправить", sending: "Отправка…",
    pickSectionFirst: "Сначала выберите хотя бы один раздел", enterRecipientFirst: "Сначала введите email получателя",
    reportEmailedTo: (email) => `Отчёт отправлен на ${email}`,
    reportSectionSchedule: "Расписание (рейсы)", reportSectionRevenue: "Доход",
    reportSectionAllotments: "Квоты туроператоров", reportSectionUtilization: "Загрузка флота",
    reportSectionIssues: "Проблемы расписания", reportSectionScrArchive: "Архив сообщений SCR",

    // ----- reports modal -----
    reportsTitle: "Отчёты",
  },
};

const LanguageContext = createContext({
  lang: "en",
  setLang: () => {},
  t: (key, fallback) => (typeof fallback === "function" ? fallback : (fallback ?? key)),
});

const STORAGE_KEY = "charterops_lang";

export function LanguageProvider({ children }) {
  const [lang, setLangState] = useState("en");
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved === "ru" || saved === "en") setLangState(saved);
    } catch {}
  }, []);
  const setLang = useCallback((l) => {
    setLangState(l);
    try { window.localStorage.setItem(STORAGE_KEY, l); } catch {}
  }, []);
  // t(key, ...args) — if the dictionary entry is a function (for strings that need
  // interpolation), call it with args; otherwise return the string as-is. Falls back to the
  // English string, then the raw key, so a missing translation never renders blank.
  const t = useCallback((key, ...args) => {
    const entry = translations[lang]?.[key] ?? translations.en[key] ?? key;
    return typeof entry === "function" ? entry(...args) : entry;
  }, [lang]);
  return <LanguageContext.Provider value={{ lang, setLang, t }}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  return useContext(LanguageContext);
}
