/**
 * The `Msg` bodies the client expects behind each {@link NotificationType}.
 *
 * Recovered from the client's Utf8Json generated formatters (see `recnet-patcher`,
 * `il2cpp-tools/dtoshape.py`), not from a spec. Three properties of that decoder decide how
 * much these matter:
 *
 * - **Every key is accepted in three casings** — Original, camelCase and all-lowercase. So
 *   `RoomId`, `roomId` and `roomid` are the same field. The spelling used below is the
 *   client's own canonical one.
 * - **Unknown members are dropped in silence.** A typo'd key behaves exactly like an omitted
 *   one, which is why a wrong payload shows up as a blank UI rather than an error.
 * - **A missing nested object is worse than a missing scalar.** Several handlers dereference
 *   one level down with no null guard, so omitting a nested field surfaces as a bare
 *   `NullReferenceException` in the client. Send a stub rather than nothing.
 *
 * Field *names* below are verified. Where a payload's type mapping could not be pinned down
 * as confidently as its key list, the interface says so on the member.
 */

/** How a balance came to change. Log/telemetry only on the purchase frame — see below. */
export enum BalanceAddType {
	Invalid = 0,
	DirectBalanceWithMultiplier = 1,
	FromGiftBox = 2,
	NUXChallenge = 10,
	AllNUXChallenges = 11,
	DailyChallenge = 100,
	AllDailyChallenges = 101,
	FinishActivity = 200,
	RecRoyaleMatchFinished = 250,
	ChecklistCredit = 303,
	WonGame = 1000,
	LostGame = 1001,
	WonGameRateLimited = 1002,
	WonGamePartial = 1003,
	LevelUp = 1100,
	Registered = 1200,
	CreatorReward = 1300,
	CommercePurchase = 1400,
	CommercePurchaseRevoked = 1401,
	ManualRefund = 2000,
	ManualThanks = 2010,
	ManualApology = 2020,
}

/**
 * Which store a balance belongs to. Note the **wire key is `Platform`, not `BalanceType`** —
 * the client's property is called `BalanceType` but carries a `[DataMember]` rename, so
 * `balanceType` on the wire is dropped and the balance silently reads as `SteamPurchased`.
 *
 * Balances are held per `(CurrencyType, Platform)` pair, so this also selects which bucket a
 * balance frame updates. `RecNetPurchased` is the one to use for a self-hosted store.
 */
export enum BalancePlatform {
	NonPurchasedNotUsableInP2P = -2,
	NonPurchasedDefault = -1,
	SteamPurchased = 0,
	OculusPurchased = 1,
	PlayStationPurchased = 2,
	MicrosoftPurchased = 3,
	RecNetPurchased = 4,
	IOSPurchased = 5,
	GooglePlayPurchased = 6,
	PicoPurchased = 8,
	PlayStationNonPurchasedP2P = 100,
	NonPlayStationNonPurchasedP2P = 101,
	NonPurchasedEarnedByP2P = 1000,
}

export enum CurrencyType {
	Invalid = 0,
	LaserTagTickets = 1,
	RecCenterTokens = 2,
	LostSkullsGold = 100,
	DraculaSilver = 101,
	RecRoyaleSeason1 = 200,
	RoomCurrency = 300,
	ProgressionEvent = 400,
}

/** Why a player was kicked/banned/warned. Shared by ModerationKick and ModerationUnkick. */
export enum KickReportCategory {
	Moderator = -1,
	Unknown = 0,
	DeprecatedMicrophoneAbuse = 1,
	Harassment = 2,
	Cheating = 3,
	DeprecatedImmatureBehavior = 4,
	AFK = 5,
	Misc = 6,
	Underage = 7,
	VoteKick = 10,
	MisleadingPurchases = 11,
	CoCUnderage = 100,
	CoCSexual = 101,
	CoCDiscrimination = 102,
	CoCTrolling = 103,
	CoCNameOrProfile = 104,
	InappropriateClothing = 200,
	IssuingInaccurateReports = 1000,
}

export enum LogoutReason {
	Unknown = 0,
	UserInitiated = 1,
	SessionTakeover = 2,
	ForciblyLoggedOut = 3,
	Banned = 4,
}

/** The error the client renders when a `GoTo` fails. */
export enum GoToFailureError {
	UnknownError = -1,
	Success = 0,
	NoSuchGame = 1,
	PlayerNotOnline = 2,
	InsufficientSpace = 3,
	EventNotStarted = 4,
	EventAlreadyFinished = 5,
	BlockedFromRoom = 7,
	JuniorNotAllowed = 11,
	Banned = 12,
	AlreadyInBestInstance = 13,
	InsufficientRelationship = 14,
	UpdateRequired = 16,
	AlreadyInTargetInstance = 17,
	UGCNotAllowed = 19,
	NoSuchRoom = 20,
	RoomIsNotActive = 22,
	RoomBlockedByCreator = 23,
	RoomIsPrivate = 25,
	RoomInstanceIsPrivate = 26,
	DeviceClassNotSupported = 30,
	DeviceClassNotSupportedByRoomOwner = 31,
	MovementModeNotSupportedByRoomOwner = 32,
	EventIsPrivate = 35,
	EventIsFull = 36,
	RoomInviteExpired = 40,
	NoAvailableRegion = 45,
}

// ---- Payloads ------------------------------------------------------------------

/** `StorefrontBalancePurchase` (62). */
export interface PurchaseBalanceModificationPayload {
	BalanceAddType: BalanceAddType
	/**
	 * The change, **for display only** — the client does not apply it. Its handler logs a
	 * line and then stores {@link Balance} outright, so a correct `Delta` with a stale
	 * `Balance` leaves the player's balance wrong.
	 */
	Delta: number
	/** The post-transaction total. Absolute, and the only field that changes client state. */
	Balance: number
	Platform: BalancePlatform
	CurrencyType: CurrencyType
}

/** `StorefrontBalanceUpdate` (61) — a bare set of one bucket to an absolute value. */
export interface BalanceResponsePayload {
	Balance: number
	CurrencyType: CurrencyType
	Platform: BalancePlatform
}

/** One element of the `StorefrontBalanceAdd` (60) batch. */
export interface RewardBalanceModificationPayload {
	BalanceAddType: BalanceAddType
	BaseAward: number
	BonusAward: number
	RateLimit: number
	CurrentCount: number
	Total: number
	Platform: BalancePlatform
	BalanceInGiftBox: boolean
}

/** `ConsumableMappingAdded` (70) / `ConsumableMappingRemoved` (71). */
export interface ConsumableMappingPayload {
	Id: number
	ConsumableItemDesc: string
	Count: number
	InitialCount: number
	/** ISO-8601. */
	CreatedAt: string
	ActiveDurationMinutes: number | null
	IsActive: boolean
	IsTransferable: boolean
}

/** `ModerationKick` (22) and `ModerationUnkick`. Room bans go out as this with `IsBan`. */
export interface ModerationKickPayload {
	ReportCategory: KickReportCategory
	/** Seconds. */
	Duration: number
	GameSessionId: number
	IsHostKick: boolean
	Message: string
	PlayerIdReporter: number | null
	IsBan: boolean
	IsVoiceModAutoban: boolean
	IsWarning: boolean
	VoteKickReason: string
	/** ISO-8601. */
	TimeoutStartedAt: string | null
}

/** `ModerationKickAttemptFailed` (23) — a vote-kick that didn't carry. */
export interface ModerationKickFailedPayload {
	ReportCategory: KickReportCategory
	YesVotes: number
	NoVotes: number
	PlayerIdReported: number
}

/** `ServerMaintenance` (25). */
export interface ServerMaintenancePayload {
	StartsInMinutes: number
}

/** `Logout` (6). */
export interface LogoutPayload {
	Reason: LogoutReason
}

/** `MessageDeleted` (3) — the id of the message to drop. */
export interface MessageDeletedPayload {
	Id: number
}

/** `MessageReceived` (2). */
export interface MessageReceivedPayload {
	Id: number
	FromPlayerId: number
	/** ISO-8601. */
	SentTime: string
	Type: number
	Data: string
	RoomId: number | null
	PlayerEventId: number | null
}

/** `RelationshipChanged` (1). */
export interface RelationshipChangedPayload {
	/** Note the spelling — capital `ID`, unlike every other id key on the wire. */
	PlayerID: number
	RelationshipType: number
	Muted: boolean
	Ignored: boolean
	Favorited: boolean
}

/** `PlayerEventDeleted` (82) / `PlayerEventResponseDeleted` (84). */
export interface PlayerEventIdPayload {
	PlayerEventId: number
}

/** `PlayerEventResponseChanged` (83). */
export interface PlayerEventResponsePayload {
	PlayerEvent: Record<string, unknown>
	PlayerEventResponse: Record<string, unknown>
}

/** `PlayerEventCreated` (80) / `PlayerEventUpdated` (81). */
export interface PlayerEventPayload {
	Tags: unknown[]
	PlayerEventId: number
	CreatorPlayerId: number
	RoomId: number
	SubRoomId: number | null
	ClubId: number | null
	Name: string
	Description: string
	ImageName: string
	/** ISO-8601. */
	StartTime: string
	/** ISO-8601. */
	EndTime: string
	AttendeeCount: number
	Accessibility: number
	IsMultiInstance: boolean
	SupportMultiInstanceRoomChat: boolean
	DefaultBroadcastPermissions: number
	CanRequestBroadcastPermissions: number
	BroadcastingRoomInstanceId: number | null
}

/** `PlayerProgressionLevelUpdate`. `XP` is progress into the level, not a lifetime total. */
export interface PlayerProgressionLevelPayload {
	PlayerId: number
	Level: number
	XP: number
}

/** `ProgressionEventsRecordUpdate`. */
export interface ProgressionEventRecordPayload {
	AccountId: number
	Xp: number
	GameMinutesToday: number
	RewardsCollected: number
	BonusRewardsCollected: number
	/** ISO-8601. */
	XpBoostLastPurchasedAt: string | null
}

/**
 * `SubscriptionUpdateProfile` (`"AccountUpdate"`) — the public projection of an account.
 * The `Obscured*` CodeStage wrappers on the client side serialise as their plain underlying
 * value, so nothing special is needed on the wire.
 */
export interface AccountUpdatePayload {
	AccountId: number
	UserName: string
	DisplayName: string
	DisplayEmoji: string
	ProfileImage: string
	BannerImage: string
	TreatAsJunior: boolean
	HasBirthday: boolean
	PersonalPronouns: number
	IdentityFlags: number
	/** Lowercase-camel on the client's canonical spelling, unlike its neighbours. */
	createdAt: string
	IsJunior: boolean | null
}

/**
 * `SubscriptionUpdateSelfProfile` (`"SelfAccountUpdate"`) — the owner-only projection: the
 * six private fields **first**, then every field of {@link AccountUpdatePayload}. That order
 * is not cosmetic; the client's decoder emits a derived DTO's own members before its base's.
 */
export interface SelfAccountUpdatePayload extends AccountUpdatePayload {
	Email: string
	Phone: string
	/** ISO-8601. Its absence is what caused the under-13 junior crash. */
	Birthday: string | null
	JuniorState: number
	ParentAccountId: number | null
	AvailableUsernameChanges: number
}

/** `ChatMessageReceived` and `PlayerLeftChat` — same shape. */
export interface ChatMessagePayload {
	ChatMessageId: number
	ChatThreadId: number
	SenderPlayerId: number
	/** ISO-8601. */
	TimeSent: string
	Contents: string
	ModerationState: number
}

/** `ClubMembershipUpdate`. */
export interface ClubMembershipPayload {
	ClubId: number
	MembershipType: number
}

/** `CreatorClubSubscriptionUpdate`. */
export interface CreatorClubSubscriptionPayload {
	CreatorAccountId: number
	ClubId: number
	MembershipType: number
}

/** `RoomCurrencyCreated` / `RoomCurrencyModified`. */
export interface RoomCurrencyPayload {
	CurrencyId: string
	RoomId: number | null
	Name: string
	Description: string
	CurrencyType: CurrencyType
	Limit: number
	ImageName: string
	/** ISO-8601. */
	CreatedAt: string
	/** ISO-8601. */
	ModifiedAt: string
}

/** `RoomCurrencyDeleted`. */
export interface RoomCurrencyDeletedPayload {
	CurrencyId: string
}

/** `LocalRoomKeyCreated` (120). */
export interface LocalRoomKeyPayload {
	RoomKeyId: number
	ReplicationId: string
	RoomId: number
	Name: string
	Description: string
	Price: number
	PurchaseCurrencyId: string | null
	/** ISO-8601. */
	CreatedAt: string
	ImageName: string
}

/** `LocalRoomKeyDeleted` (121). */
export interface LocalRoomKeyDeletedPayload {
	RoomKeyId: number
}

/** `AnnouncementUpdate`. */
export interface AnnouncementPayload {
	AnnouncementId: number
	AnnouncementType: number
	Title: string
	Body: string
	ImageName: string
	LinkType: number
	LinkName: string
	LinkButtonLabel: string
	LinkUri: string
	Platform: number
	/** ISO-8601. */
	CreatedAt: string
}

/** `AnnouncementDelete`. */
export interface AnnouncementDeletePayload {
	AnnouncementId: number
}

/** `CommunityBoardAnnouncementUpdate` (96) — the board's single current announcement. */
export interface CommunityBoardAnnouncementPayload {
	Message: string
	MoreInfoUrl: string
}

/** `ReputationUpdate`. */
export interface ReputationPayload {
	AccountId: number
	IsCheerful: boolean
	SelectedCheer: number | null
	CheerCredit: number
	CheerGeneral: number
	CheerHelpful: number
	CheerCreative: number
	CheerGreatHost: number
	CheerSportsman: number
}

/** `PhotonAccessToken`. */
export interface PhotonAccessTokenPayload {
	RoomInstanceId: number
	PhotonAccessToken: string
	Permissions: unknown[]
}

/** `KeepsakeInstanceAdded` / `KeepsakeInstanceRemoved`. */
export interface KeepsakeInstancePayload {
	KeepsakeInstanceId: string
	KeepsakeCategoryConfigId: number
	PlacedByAccountId: number
	RoomId: number
	SubRoomId: number | null
}

/** `PlayerCustomAvatarItemModerated`. */
export interface CustomAvatarItemPayload {
	CustomAvatarItemId: string
	CreatorAccountId: number
	Name: string
	Description: string
	Price: number
	Accessibility: number
	IsFeatured: boolean
	BaseAvatarItemId: number | null
	BaseAvatarItemColor: string
	DesignFilename: string
	ThumbnailImageFilename: string
	/** ISO-8601. */
	CreatedAt: string
	/** ISO-8601. */
	ModifiedAt: string
}

/** `GoToFailure`. */
export interface GoToFailurePayload {
	Error: GoToFailureError
}

/** `AppVersionUpdate` — the live replacement for the dead `ModerationUpdateRequired` (21). */
export interface AppVersionUpdatePayload {
	ActivePlatforms: unknown
}

/** `IncentivizedReferralUpdate`. */
export interface IncentivizedReferralPayload {
	InviteeAccountId: number
	/** ISO-8601. */
	CreatedAt: string
	/** ISO-8601. */
	VerifiedAt: string | null
}

/** `InfluencerSupportedUpdate`. */
export interface InfluencerSupportedPayload {
	SupportedInfluencerId: number | null
}

/** `StringAutoLocalizationJob`. */
export interface StringAutoLocalizationJobPayload {
	Scope: string
	Status: number
}

/** `SubscriptionUpdateGameSession` (`"RoomInstanceUpdate"`). */
export interface RoomInstanceUpdatePayload {
	RoomInstanceId: number
	RoomId: number
	SubRoomId: number
	Location: string
	EventId: number
	ClubId: number
	RoomCode: string
	/** Canonical spelling is lower-camel here, unlike its neighbours. */
	photonRegionId: string
	PhotonRoomId: string
	Name: string
	MaxCapacity: number
	IsFull: boolean
	IsPrivate: boolean
	IsInProgress: boolean
	EncryptVoiceChat: boolean
	RoomInstanceType: number
	MatchmakingPolicy: number
}

/**
 * `GiftPackageReceived` (30), `GiftPackageReceivedImmediate` (31) and
 * `GiftPackageRewardSelectionReceived` (32) all carry this. Note `BalanceType` here is NOT
 * the renamed-to-`Platform` field seen on the balance payloads — it is its own member and
 * keeps its name; `Platform` is a separate key on the same object.
 */
export interface GiftPackagePayload {
	Id: number | null
	FromPlayerId: number | null
	ConsumableItemDesc: string
	AvatarItemType: number | null
	AvatarItemDesc: string
	EquipmentPrefabName: string
	EquipmentModificationGuid: string
	CurrencyType: CurrencyType
	Currency: number
	Xp: number
	GiftContext: number
	GiftRarity: number
	Message: string
	Platform: number
	PlatformsToSpawnOn: unknown
	BalanceType: BalancePlatform | null
}

/** `gift.manualconsumed`. */
export interface GiftManualConsumedPayload {
	GiftPackageId: number
}

/** `RewardSelectionReceived` — distinct from the gift-package frames above. */
export interface RewardSelectionPayload {
	RewardSelectionId: number
	RewardType: number
	Message: string
	GiftContext: number
	GiftDrop1: unknown
	GiftDrop2: unknown
	GiftDrop3: unknown
	Subscriber_GiftDrop3: unknown
	/** ISO-8601. */
	CreatedAt: string
}

/**
 * Channels whose handler takes no argument at all — the client refetches rather than reading
 * the frame. Send `{}`; anything else is ignored.
 */
export type NoPayload = Record<string, never>
