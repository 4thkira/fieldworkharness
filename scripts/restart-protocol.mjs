// A browser-requested restart closes the room cleanly, then asks the one-step
// launcher to start the same command again. Keep this code private to that
// parent/child protocol so ordinary failures never become restart loops.
export const FIELDWORK_RESTART_EXIT_CODE = 75;
