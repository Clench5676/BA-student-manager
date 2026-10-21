// The first saved variant alias is the display name; all saved aliases remain searchable and editable.
export const customAliases = (variant) => (Array.isArray(variant?.custom) ? variant.custom.filter((a) => typeof a === "string" && a) : []);
export const studentName = (variant, original) => customAliases(variant)[0] || original;

// A mod's label may already be its alias. Its core and file name still identify the original game resource.
export const modOriginalName = (mod) => mod?.core || mod?.file?.split(/[\\/]/).pop() || (mod?.label !== mod?.alias ? mod?.label : "") || "";
