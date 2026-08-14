/**
 * The client's `NotificationType` enum — the `Id` carried on a hub notification frame
 * (`{ Id, Msg }`, see {@link NotificationsHub}). The reference server sends these as the
 * notification type so the client's dispatcher can route each frame (e.g. remove a consumed
 * item from inventory on ConsumableMappingRemoved).
 *
 * Mostly integers, but some members are STRINGS, and that is not an inconsistency to tidy
 * up: the reference's hub sends a wire name for those frames (`"AccountUpdate"`,
 * `"RoomUpdate"`, …) even where its own Go enum has a number for them, and the frame's `Id`
 * is stringified as-is — so a member's value is whatever that frame is actually addressed
 * by. Where the two disagree, the wire wins; the number is noted in the member's comment.
 *
 * Lives in the `notify` worker (the hub owner); other workers import it to send a
 * typed notification instead of a magic number. No runtime dependencies, so it's safe
 * to import as a value from another worker's bundle.
 *
 * ## How this was verified
 *
 * Every member below was checked against the client's own subscription table, recovered by
 * static analysis of `GameAssembly.dll` (see `recnet-patcher`, `il2cpp-tools/regall.py`).
 * The client registers each channel by key — a decimal string for numeric ids, a name for
 * the rest — and **a key with no subscriber is dropped in silence**: the frame parses, no
 * handler runs, nothing is logged. So "the client ignores this" is indistinguishable from
 * "the server never sent it" at runtime, which is why the status is recorded here instead.
 *
 * Members marked `@deadOnClient` have no subscriber in the build this was taken from
 * (20230414-era, `GameAssembly.dll` 156,069,888 bytes). They are kept because they name a
 * real client enum member and may come back in another build — but sending one today is a
 * no-op. Everything not so marked was confirmed to have a live handler.
 */
export enum NotificationType {
	RelationshipChanged = 1,
	MessageReceived = 2,
	MessageDeleted = 3,
	/**
	 * @deadOnClient No subscriber, and unlike its neighbours it has no wire-name twin either —
	 * the string `PresenceHeartbeat…` does not appear anywhere in the client's metadata. The
	 * heartbeat response has nowhere to land in this build.
	 */
	PresenceHeartbeatResponse = 4,
	/** Also reachable as the wire name `"PlayerPrivileges.Refresh"` — same handler. */
	RefreshLogin = 5,
	Logout = 6,
	SubscriptionUpdateProfile = 'AccountUpdate',
	/**
	 * The owner-only twin of {@link SubscriptionUpdateProfile}: the same account, rendered
	 * with the private fields (email, birthday, remaining username changes). The reference
	 * sends both on connect and after a profile mutation — everyone gets the public frame,
	 * the owner additionally gets this one. Named after its twin rather than after a client
	 * enum member, since the client's enum doesn't list it; the WIRE name is what matters.
	 *
	 * Confirmed live: the client subscribes `"SelfAccountUpdate"` and the payload is the
	 * public account DTO plus six owner-only fields. See `SelfAccountUpdatePayload`.
	 */
	SubscriptionUpdateSelfProfile = 'SelfAccountUpdate',
	SubscriptionUpdatePresence = 'PresenceUpdate',
	SubscriptionUpdateGameSession = 'RoomInstanceUpdate',
	/**
	 * A room the player is subscribed to changed. STRING-valued like its neighbours even
	 * though the reference's own enum numbers it `15`: its hub sends the wire name
	 * (`NotifFrame("RoomUpdate", room)`) and never the number, and the payload builder
	 * stringifies whatever it is given, so `15` would go out as the unrelated `"15"`.
	 */
	SubscriptionUpdateRoom = 'RoomUpdate',
	/** @deadOnClient No subscriber under `16` and no wire-name twin. */
	SubscriptionUpdateRoomPlaylist = 16,
	ModerationQuitGame = 20,
	/**
	 * @deadOnClient Nothing listens on `21`. {@link AppVersionUpdate} is the live channel
	 * that does this job — same handler class, addressed by name.
	 */
	ModerationUpdateRequired = 21,
	ModerationKick = 22,
	ModerationKickAttemptFailed = 23,
	/**
	 * @deadOnClient Not present in this build at all: no subscriber on `24`, and the string
	 * `"ModerationRoomBan"` does not exist in the client's metadata, so neither spelling can
	 * be dispatched. To ban from a room, use {@link ModerationKick} with `IsBan: true`.
	 */
	ModerationRoomBan = 'ModerationRoomBan',
	ServerMaintenance = 25,
	GiftPackageReceived = 30,
	GiftPackageReceivedImmediate = 31,
	/**
	 * Carries a gift package like its two neighbours. Distinct from
	 * {@link RewardSelectionReceived}, which is a different channel with a different payload.
	 */
	GiftPackageRewardSelectionReceived = 32,
	/**
	 * A player's level/XP changed — `{ PlayerId, Level, XP }`, where XP is the progress into
	 * the current level, not a lifetime total. STRING-valued: the reference's hub sends the
	 * wire name and its enum has no number for this one at all. It pushes the frame both when
	 * progression changes and when the player reads it back, which is how a client that just
	 * connected gets its bar right.
	 *
	 * Confirmed live, and the three-field payload confirmed against the client's formatter.
	 */
	PlayerProgressionLevelUpdate = 'PlayerProgressionLevelUpdate',
	/** @deadOnClient No subscriber under `40` and no wire-name twin. */
	ProfileJuniorStatusUpdate = 40,
	/** Takes no payload — the client refetches. */
	RelationshipsInvalid = 50,
	StorefrontBalanceAdd = 60,
	StorefrontBalanceUpdate = 61,
	StorefrontBalancePurchase = 62,
	ConsumableMappingAdded = 70,
	ConsumableMappingRemoved = 71,
	PlayerEventCreated = 80,
	PlayerEventUpdated = 81,
	PlayerEventDeleted = 82,
	PlayerEventResponseChanged = 83,
	PlayerEventResponseDeleted = 84,
	/** @deadOnClient No subscriber under `85` and no wire-name twin. */
	PlayerEventStateChanged = 85,
	ChatMessageReceived = 'ChatMessageReceived',
	/**
	 * STRING-valued, and this one is easy to get wrong: the client's enum *does* have a
	 * member numbered `95`, but nothing subscribes to `"95"` — the live subscription is on
	 * the name. Sending the number is a silent no-op.
	 */
	CommunityBoardUpdate = 'CommunityBoardUpdate',
	/**
	 * Numeric, unlike its `CommunityBoard` sibling above — `96` genuinely has a subscriber.
	 * Do not "unify" these two; they were checked separately. Note the *announcement list*
	 * has its own name-addressed channels ({@link AnnouncementUpdate} /
	 * {@link AnnouncementDelete}); this one is the board's single current announcement.
	 */
	CommunityBoardAnnouncementUpdate = 96,
	/** Takes no payload — the client refetches. */
	InventionModerationStateChanged = 100,
	/** Takes no payload — the client refetches. */
	FreeGiftButtonItemsAdded = 110,
	LocalRoomKeyCreated = 120,
	LocalRoomKeyDeleted = 121,

	// ---- Name-addressed channels with no client enum member ------------------
	// These have no number at all: the client subscribes them purely by name. Grouped
	// separately so the numeric block above stays a faithful mirror of the client enum.

	/** Client version gate. The live replacement for {@link ModerationUpdateRequired}. */
	AppVersionUpdate = 'AppVersionUpdate',
	AnnouncementUpdate = 'AnnouncementUpdate',
	AnnouncementDelete = 'AnnouncementDelete',
	ClubMembershipUpdate = 'ClubMembershipUpdate',
	CreatorClubSubscriptionUpdate = 'CreatorClubSubscriptionUpdate',
	CommerceSubscriptionUpdate = 'CommerceSubscriptionUpdate',
	/** Takes no payload — the client refetches `api/config/v2`. */
	GameConfigRefresh = 'GameConfig.Refresh',
	/** Takes no payload — the client refetches. */
	PlayerSettingsRefresh = 'PlayerSettings.Refresh',
	/** Matchmaking told the client its `GoTo` failed; payload is a single error code. */
	GoToFailure = 'GoToFailure',
	IncentivizedReferralUpdate = 'IncentivizedReferralUpdate',
	InfluencerSupportedUpdate = 'InfluencerSupportedUpdate',
	KeepsakeInstanceAdded = 'KeepsakeInstanceAdded',
	KeepsakeInstanceRemoved = 'KeepsakeInstanceRemoved',
	/** The un-kick; same payload type as {@link ModerationKick}. */
	ModerationUnkick = 'ModerationUnkick',
	/** Hands the client a Photon token for a room instance. */
	PhotonAccessToken = 'PhotonAccessToken',
	PlayerCustomAvatarItemModerated = 'PlayerCustomAvatarItemModerated',
	/** Same payload type as {@link ChatMessageReceived}. */
	PlayerLeftChat = 'PlayerLeftChat',
	ProgressionEventsRecordUpdate = 'ProgressionEventsRecordUpdate',
	ReputationUpdate = 'ReputationUpdate',
	/** Distinct from {@link GiftPackageRewardSelectionReceived} — different payload. */
	RewardSelectionReceived = 'RewardSelectionReceived',
	RoomCommentDeleted = 'RoomCommentDeleted',
	RoomCurrencyCreated = 'RoomCurrencyCreated',
	RoomCurrencyModified = 'RoomCurrencyModified',
	RoomCurrencyDeleted = 'RoomCurrencyDeleted',
	StringAutoLocalizationJob = 'StringAutoLocalizationJob',
	WebsiteInventionPurchase = 'WebsiteInventionPurchase',
	GiftManualConsumed = 'gift.manualconsumed',
	PushToDevice = 'rrs.pushtodevice',
}
