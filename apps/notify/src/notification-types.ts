/**
 * The client's `NotificationType` enum — the integer `Id` carried on a hub
 * notification frame (`{ Id, Msg }`, see {@link NotificationsHub}). The reference
 * server sends these as the notification type so the client's dispatcher can route
 * each frame (e.g. remove a consumed item from inventory on ConsumableMappingRemoved).
 *
 * Lives in the `notify` worker (the hub owner); other workers import it to send a
 * typed notification instead of a magic number. No runtime dependencies, so it's safe
 * to import as a value from another worker's bundle.
 */
export enum NotificationType {
	RelationshipChanged = 1,
	MessageReceived = 2,
	MessageDeleted = 3,
	PresenceHeartbeatResponse = 4,
	RefreshLogin = 5,
	Logout = 6,
	SubscriptionUpdateProfile = "AccountUpdate",
	SubscriptionUpdatePresence = "PresenceUpdate",
	SubscriptionUpdateGameSession = "RoomInstanceUpdate",
	SubscriptionUpdateRoom = 15,
	SubscriptionUpdateRoomPlaylist = 16,
	ModerationQuitGame = 20,
	ModerationUpdateRequired = 21,
	ModerationKick = 22,
	ModerationKickAttemptFailed = 23,
	ModerationRoomBan = "ModerationRoomBan",
	ServerMaintenance = 25,
	GiftPackageReceived = 30,
	GiftPackageReceivedImmediate = 31,
	GiftPackageRewardSelectionReceived = 32,
	ProfileJuniorStatusUpdate = 40,
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
	PlayerEventStateChanged = 85,
	ChatMessageReceived = "ChatMessageReceived",
	CommunityBoardUpdate = 95,
	CommunityBoardAnnouncementUpdate = 96,
	InventionModerationStateChanged = 100,
	FreeGiftButtonItemsAdded = 110,
	LocalRoomKeyCreated = 120,
	LocalRoomKeyDeleted = 121,
}
