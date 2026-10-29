local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local TweenService = game:GetService("TweenService")

local TIME_ATTRIBUTE = "UpdateDayAt"
local WARNING_EVENT_NAME = "UpdateDayWarning"
local SHOW_WITHIN_MINUTES = 60
local LIVE_MESSAGE_SECONDS = 20
local TOAST_SECONDS = 6
local REFRESH_SECONDS = 0.25
local COUNTDOWN_TEXT = "UPDATE IN %s"
local LIVE_TEXT = "THE UPDATE IS LIVE! Rejoin to play it"
local TOAST_TEXT = "Update in %s! Finish what you're doing"
local POPPINS_FONT_ID = 11702779409
local FONT = Font.fromId(POPPINS_FONT_ID, Enum.FontWeight.Bold)
local TEXT_COLOR = Color3.fromRGB(255, 255, 255)
local OUTLINE_COLOR = Color3.fromRGB(16, 18, 24)
local OUTLINE_THICKNESS = 2
local BANNER_TEXT_SIZE = 26
local TOAST_TEXT_SIZE = 20
local BANNER_SIZE = UDim2.fromOffset(460, 34)
local TOAST_SIZE = UDim2.fromOffset(460, 28)
local BANNER_POSITION = UDim2.new(0.5, 0, 0, 12)
local TOAST_POSITION = UDim2.new(0.5, 0, 0, 52)
local TWEEN = TweenInfo.new(0.25, Enum.EasingStyle.Quad, Enum.EasingDirection.Out)

local player = Players.LocalPlayer
local dismissed = false

local function outline(text)
	local item = Instance.new("UIStroke")
	item.Color = OUTLINE_COLOR
	item.Thickness = OUTLINE_THICKNESS
	item.ApplyStrokeMode = Enum.ApplyStrokeMode.Contextual
	item.Parent = text
end

local function textLine(className, gui, name, size, position, textSize)
	local text = Instance.new(className)
	text.Name = name
	text.AnchorPoint = Vector2.new(0.5, 0)
	text.Size = size
	text.Position = position
	text.BackgroundTransparency = 1
	text.FontFace = FONT
	text.TextColor3 = TEXT_COLOR
	text.TextSize = textSize
	text.Visible = false
	text.Parent = gui
	outline(text)
	return text
end

local function buildGui()
	local gui = Instance.new("ScreenGui")
	gui.Name = "UpdateDayBanner"
	gui.ResetOnSpawn = false
	gui.IgnoreGuiInset = false
	gui.DisplayOrder = 50
	gui.Parent = player:WaitForChild("PlayerGui")

	local banner = textLine("TextButton", gui, "Banner", BANNER_SIZE, BANNER_POSITION, BANNER_TEXT_SIZE)
	banner.AutoButtonColor = false
	banner.Activated:Connect(function()
		dismissed = true
		banner.Visible = false
	end)

	local toast = textLine("TextLabel", gui, "Toast", TOAST_SIZE, TOAST_POSITION, TOAST_TEXT_SIZE)

	return banner, toast
end

local function clock(seconds)
	local total = math.max(0, math.floor(seconds))
	local hours = total // 3600
	local minutes = (total % 3600) // 60
	local secs = total % 60
	if hours > 0 then
		return string.format("%d:%02d:%02d", hours, minutes, secs)
	end
	return string.format("%02d:%02d", minutes, secs)
end

local function markText(mark)
	local count, unit = string.match(tostring(mark), "^(%d+)([smhd])$")
	if not count then
		return tostring(mark)
	end
	local words = { s = "second", m = "minute", h = "hour", d = "day" }
	local n = tonumber(count)
	return string.format("%d %s%s", n, words[unit], n == 1 and "" or "s")
end

local banner, toast = buildGui()

local function showToast(text)
	toast.Text = text
	toast.Visible = true
	toast.TextTransparency = 1
	TweenService:Create(toast, TWEEN, { TextTransparency = 0 }):Play()
	task.delay(TOAST_SECONDS, function()
		if toast.Text == text then
			toast.Visible = false
		end
	end)
end

local warningEvent = ReplicatedStorage:WaitForChild(WARNING_EVENT_NAME)
warningEvent.OnClientEvent:Connect(function(_, mark)
	showToast(string.format(TOAST_TEXT, markText(mark)))
end)

ReplicatedStorage:GetAttributeChangedSignal(TIME_ATTRIBUTE):Connect(function()
	dismissed = false
end)

while true do
	local updateAt = ReplicatedStorage:GetAttribute(TIME_ATTRIBUTE)
	local visible = false
	if typeof(updateAt) == "number" and not dismissed then
		local left = updateAt - workspace:GetServerTimeNow()
		if left > 0 and left <= SHOW_WITHIN_MINUTES * 60 then
			banner.Text = string.format(COUNTDOWN_TEXT, clock(left))
			visible = true
		elseif left <= 0 and left > -LIVE_MESSAGE_SECONDS then
			banner.Text = LIVE_TEXT
			visible = true
		end
	end
	banner.Visible = visible
	task.wait(REFRESH_SECONDS)
end
