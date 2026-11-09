// Batch dates, on their own so other modules can share them without importing each other in a circle.

/** Batch date for ordering: the library-prep date if entered, else when the batch was created. */
export const batchDate = b => (b.info?.prep ? `${b.info.prep}T12:00:00` : b.created);
