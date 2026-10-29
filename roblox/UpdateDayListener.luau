local MessagingService = game:GetService("MessagingService")
local HttpService = game:GetService("HttpService")

local DEFAULT_TOPIC = "UpdateDay"

local UpdateDayListener = {}

local listeners = {}

local function decode(message)
	local ok, payload = pcall(HttpService.JSONDecode, HttpService, message.Data)
	if ok and typeof(payload) == "table" then
		return payload
	end
	return nil
end

local function onMessage(message)
	local payload = decode(message)
	if not payload or typeof(payload.updateAt) ~= "string" then
		return
	end
	local updateAt = DateTime.fromIsoDate(payload.updateAt)
	if not updateAt then
		return
	end
	for _, callback in listeners do
		task.spawn(callback, updateAt.UnixTimestamp, payload.mark)
	end
end

function UpdateDayListener.OnWarning(callback)
	table.insert(listeners, callback)
end

function UpdateDayListener.Start(topic)
	local ok, err = pcall(MessagingService.SubscribeAsync, MessagingService, topic or DEFAULT_TOPIC, onMessage)
	if not ok then
		warn("UpdateDayListener failed to subscribe:", err)
	end
end

return UpdateDayListener
