local DataStoreService = game:GetService("DataStoreService")
local HttpService = game:GetService("HttpService")
local MessagingService = game:GetService("MessagingService")
local Players = game:GetService("Players")

local STORE_NAME = "UpdateDayGifts"
local TOPIC = "UpdateDayGifts"
local RETRY_DELAY = 5

local UpdateDayGifts = {}

local store = DataStoreService:GetDataStore(STORE_NAME)
local handlers = {}
local busy = {}

local function giftsOf(value)
	if typeof(value) == "table" and typeof(value.gifts) == "table" then
		return value.gifts
	end
	return {}
end

local function claimAll(userId)
	local claimed = {}
	local ok, err = pcall(store.UpdateAsync, store, tostring(userId), function(current)
		claimed = giftsOf(current)
		if #claimed == 0 then
			return nil
		end
		return { gifts = {} }
	end)
	if not ok then
		warn("UpdateDayGifts could not read gifts:", err)
		return {}
	end
	return claimed
end

local function putBack(userId, gifts)
	if #gifts == 0 then
		return
	end
	local ok, err = pcall(store.UpdateAsync, store, tostring(userId), function(current)
		local merged = giftsOf(current)
		for _, gift in gifts do
			table.insert(merged, gift)
		end
		return { gifts = merged }
	end)
	if not ok then
		warn("UpdateDayGifts could not put gifts back:", err, HttpService:JSONEncode(gifts))
	end
end

local function give(player, gift)
	local handler = handlers[gift.category]
	if not handler then
		return false
	end
	local ok, result = pcall(handler, player, gift)
	if not ok then
		warn("UpdateDayGifts handler failed for", gift.category, result)
		return false
	end
	return result ~= false
end

local function deliver(player)
	if busy[player] then
		return
	end
	busy[player] = true
	local failed = {}
	for _, gift in claimAll(player.UserId) do
		if not give(player, gift) then
			table.insert(failed, gift)
		end
	end
	putBack(player.UserId, failed)
	busy[player] = nil
end

local function onMessage(message)
	local ok, payload = pcall(HttpService.JSONDecode, HttpService, message.Data)
	if not ok or typeof(payload) ~= "table" then
		return
	end
	local player = Players:GetPlayerByUserId(tonumber(payload.userId) or 0)
	if player then
		deliver(player)
	end
end

local function subscribe()
	local ok, err = pcall(MessagingService.SubscribeAsync, MessagingService, TOPIC, onMessage)
	if not ok then
		warn("UpdateDayGifts could not subscribe, retrying:", err)
		task.delay(RETRY_DELAY, subscribe)
	end
end

function UpdateDayGifts.OnGift(category, handler)
	handlers[category] = handler
end

function UpdateDayGifts.Start()
	Players.PlayerAdded:Connect(function(player)
		task.spawn(deliver, player)
	end)
	Players.PlayerRemoving:Connect(function(player)
		busy[player] = nil
	end)
	for _, player in Players:GetPlayers() do
		task.spawn(deliver, player)
	end
	task.spawn(subscribe)
end

return UpdateDayGifts
