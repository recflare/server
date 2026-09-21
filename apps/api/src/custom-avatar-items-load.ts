/**
 * Turning an export of custom avatar items into `custom_avatar_item` rows — the loader half of
 * the table, used by `runx admin cai-load` (in @repo/tools) and by the migration generator
 * (scripts/import-custom-avatar-items.ts) rather than by the worker.
 *
 * Separate from `custom-avatar-items-db.ts` for the reason `catalog-load.ts` is separate from
 * `catalog-db.ts` in econ: that module types its queries with `D1Database`, a Workers type,
 * and the loader runs in a plain Node CLI that has no such types. Everything here is pure data
 * mapping with no imports, so both sides can use it.
 *
 * A row is the record as JSON (see 0022_custom_avatar_item_json.sql), so a load is the export
 * verbatim: no per-field mapping, and a field the source adds later rides along. Three things
 * change on the way in: `PurchaseInfo`, a store-side projection the worker fills at read time,
 * is stripped; `CreatorAccountId` is FORCED to the Coach account; and each save's
 * `ThumbnailFileName` is put under the `avatar/` prefix — see {@link customAvatarItemRowLiteral}.
 */

/**
 * The "Coach" system account — this server's stock content is authored by it, the same id the
 * `econ` worker attributes a self-buy or an anonymous gift to. Defined here rather than in
 * `custom-avatar-items-db.ts` (which re-exports it) so the loader can name it without pulling
 * in Workers types.
 */
export const COACH_ACCOUNT_ID = 1

/**
 * Where a save's thumbnail is served from. The export names it bare
 * (`f2y1ndzuvm5ke2hjmn4cwfwfl.png`); this server keeps those images under `avatar/` in the
 * image bucket, so the name is prefixed on the way in and the client asks for the right key.
 */
export const SAVE_THUMBNAIL_PREFIX = 'avatar/'

/** The least an export record must carry to be a row. Everything else is kept as-is. */
export interface CustomAvatarItemExportRecord {
	CustomAvatarItemId: string
	PurchaseInfo?: unknown
	[key: string]: unknown
}

/**
 * The records in an export, whether it is a bare JSON array, a `{ Results: [...] }` page, or a
 * single record. Refuses a record without an id and a repeated id — a repeat in one upsert
 * statement is an error at the database, and a repeat across statements would silently keep
 * whichever came last, which is a defect in the export rather than a choice to make for it.
 */
export function readCustomAvatarItemExport(parsed: unknown): CustomAvatarItemExportRecord[] {
	const records: unknown[] = Array.isArray(parsed)
		? parsed
		: parsed &&
			  typeof parsed === 'object' &&
			  Array.isArray((parsed as { Results?: unknown }).Results)
			? (parsed as { Results: unknown[] }).Results
			: [parsed]
	const seen = new Set<string>()
	return records.map((record, i) => {
		if (!record || typeof record !== 'object' || Array.isArray(record)) {
			throw new Error(`record ${i} is not an object`)
		}
		const id = (record as { CustomAvatarItemId?: unknown }).CustomAvatarItemId
		if (typeof id !== 'string' || id === '') {
			throw new Error(`record ${i} has no CustomAvatarItemId`)
		}
		if (seen.has(id)) throw new Error(`duplicate CustomAvatarItemId in export: ${id}`)
		seen.add(id)
		return record as CustomAvatarItemExportRecord
	})
}

/**
 * A save's `ThumbnailFileName` under {@link SAVE_THUMBNAIL_PREFIX}. Idempotent — a name that
 * already carries the prefix is left alone — so loading a file that was itself dumped from
 * this table does not stack a second `avatar/`. Anything that is not a non-empty string
 * (null, absent) is returned as it came.
 */
export function prefixSaveThumbnail(name: unknown): unknown {
	if (typeof name !== 'string' || name === '') return name
	return name.startsWith(SAVE_THUMBNAIL_PREFIX) ? name : SAVE_THUMBNAIL_PREFIX + name
}

/**
 * A save's assetbundle hash as it is stored: BLANK. The export's `UnityAssetHash` /
 * `UnityAsset2Hash` are the hashes of the PC builds, and one stored save is served to every
 * build target — a Quest asking with `unityAssetTarget=2` is pointed at the `quest/` build of
 * the same bundle, whose bytes (and so whose hash) differ. The client checks a download against
 * a hash it is given and refuses the mismatch, so the Quest rendered nothing until these were
 * emptied by hand; given `""` it skips the check. A hash that is already null — the
 * `UnityAsset2Hash` of a save with no second bundle — stays null, so the pair keeps agreeing.
 */
export function blankAssetHash(hash: unknown): unknown {
	return typeof hash === 'string' ? '' : hash
}

/**
 * One record as the SQL string literal its row holds: the JSON, minus `PurchaseInfo`, with
 * three things rewritten.
 *
 * `CreatorAccountId` is overridden to {@link COACH_ACCOUNT_ID} whatever the export said. An
 * imported item is first-party content by definition, and the creator id is what makes it so
 * here: the storefront tab finds stock items by `creator_account_id = 1`
 * (`includeCoachItems=True`), and a sale pays the creator. An export from another server
 * carries THAT server's creator ids — an item filed under one of those would vanish from the
 * storefront into the user-generated tab, and its price would be paid to whichever local
 * account happened to share the number.
 *
 * Each save's `ThumbnailFileName` is prefixed with {@link SAVE_THUMBNAIL_PREFIX}, which is where
 * this server serves those images from, and its `UnityAssetHash`/`UnityAsset2Hash` are blanked
 * (see {@link blankAssetHash}). The rest of the save — the assetbundle names above all — is
 * untouched.
 */
export function customAvatarItemRowLiteral(record: CustomAvatarItemExportRecord): string {
	const { PurchaseInfo: _purchaseInfo, ...stored } = record
	const saves = Array.isArray(stored.CurrentSaves)
		? stored.CurrentSaves.map((save: unknown) => {
				if (!save || typeof save !== 'object' || Array.isArray(save)) return save
				const fields = save as Record<string, unknown>
				return {
					...fields,
					ThumbnailFileName: prefixSaveThumbnail(fields.ThumbnailFileName),
					// Only where the export carries the key, so a save is never GIVEN a field.
					...('UnityAssetHash' in fields && {
						UnityAssetHash: blankAssetHash(fields.UnityAssetHash),
					}),
					...('UnityAsset2Hash' in fields && {
						UnityAsset2Hash: blankAssetHash(fields.UnityAsset2Hash),
					}),
				}
			})
		: stored.CurrentSaves
	const row = { ...stored, CreatorAccountId: COACH_ACCOUNT_ID, CurrentSaves: saves }
	return `'${JSON.stringify(row).replaceAll("'", "''")}'`
}

/**
 * The largest statement a load builds, in bytes of SQL. D1 caps a single statement at 100 KB,
 * and a record with three built saves runs to a few KB, so rows are grouped by size rather
 * than by count — a fixed count would fit the small records and overflow on the large ones.
 */
export const CUSTOM_AVATAR_ITEM_LOAD_STATEMENT_BYTES = 64 * 1024

/**
 * The statements that upsert `records` into `custom_avatar_item`, each a multi-row INSERT
 * within {@link CUSTOM_AVATAR_ITEM_LOAD_STATEMENT_BYTES}. An id already in the table has its
 * row REPLACED (`ON CONFLICT ... DO UPDATE`), so a re-run with a corrected export lands and a
 * re-run with the same one changes nothing. Nothing is deleted: rows the export does not
 * mention — the players' own shirts among them — are left alone.
 */
export function customAvatarItemUpsertStatements(
	records: CustomAvatarItemExportRecord[],
	maxBytes = CUSTOM_AVATAR_ITEM_LOAD_STATEMENT_BYTES
): string[] {
	const head = 'INSERT INTO custom_avatar_item (data) VALUES\n'
	const tail = '\nON CONFLICT(custom_avatar_item_id) DO UPDATE SET data = excluded.data;'
	const statements: string[] = []
	let rows: string[] = []
	let bytes = 0
	const flush = (): void => {
		if (rows.length === 0) return
		statements.push(head + rows.map((r) => `\t(${r})`).join(',\n') + tail)
		rows = []
		bytes = 0
	}
	for (const record of records) {
		const literal = customAvatarItemRowLiteral(record)
		// A single oversized record still gets its own statement rather than being dropped.
		if (rows.length > 0 && bytes + literal.length > maxBytes) flush()
		rows.push(literal)
		bytes += literal.length + 4
	}
	flush()
	return statements
}
