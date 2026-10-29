local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ServerScriptService = game:GetService("ServerScriptService")

local TOPIC = "UpdateDay"
local MANUAL_UPDATE_AT = ""
local TIME_ATTRIBUTE = "UpdateDayAt"
local WARNING_EVENT_NAME = "UpdateDayWarning"

local UpdateDayListener = require(ServerScriptService:WaitForChild("UpdateDayListener"))

local function warningEvent()
	local existing = ReplicatedStorage:FindFirstChild(WARNING_EVENT_NAME)
	if existing then
		return existing
	end
	local event = Instance.new("RemoteEvent")
	event.Name = WARNING_EVENT_NAME
	event.Parent = ReplicatedStorage
	return event
end

local function setUpdateTime(unixSeconds)
	if typeof(unixSeconds) == "number" and unixSeconds > 0 then
		ReplicatedStorage:SetAttribute(TIME_ATTRIBUTE, unixSeconds)
	end
end

local function applyManualTime()
	if MANUAL_UPDATE_AT == "" then
		return
	end
	local parsed = DateTime.fromIsoDate(MANUAL_UPDATE_AT)
	if parsed then
		setUpdateTime(parsed.UnixTimestamp)
	else
		warn("UpdateDayCountdown: MANUAL_UPDATE_AT isn't an ISO date like 2026-11-01T17:00:00Z")
	end
end

local event = warningEvent()
applyManualTime()

UpdateDayListener.OnWarning(function(unixSeconds, mark)
	setUpdateTime(unixSeconds)
	event:FireAllClients(unixSeconds, mark)
end)

UpdateDayListener.Start(TOPIC)
