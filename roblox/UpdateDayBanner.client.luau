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
local BACKGROUND = Color3.fromRGB(16, 18, 24)
local ACCENT = Color3.fromRGB(255, 196, 61)
local TEXT_COLOR = Color3.fromRGB(255, 255, 255)
local FONT = Enum.Font.GothamBlack
local BANNER_SIZE = UDim2.fromOffset(300, 46)
local BANNER_POSITION = UDim2.new(0.5, 0, 0, 12)
local TOAST_POSITION = UDim2.new(0.5, 0, 0, 66)
local TWEEN = TweenInfo.new(0.25, Enum.EasingStyle.Quad, Enum.EasingDirection.Out)

local player = Players.LocalPlayer
local dismissed = false

local function corner(parent, radius)
	local item = Instance.new("UICorner")
	item.CornerRadius = UDim.new(0, radius)
	item.Parent = parent
end

local function stroke(parent)
	local item = Instance.new("UIStroke")
	item.Color = ACCENT
	item.Thickness = 2
	item.Parent = parent
end

local function label(parent, size, position)
	local text = Instance.new("TextLabel")
	text.BackgroundTransparency = 1
	text.Size = size
	text.Position = position
	text.Font = FONT
	text.TextColor3 = TEXT_COLOR
	text.TextScaled = true
	text.Parent = parent
	local limit = Instance.new("UITextSizeConstraint")
	limit.MaxTextSize = 22
	limit.Parent = text
	return text
end

local function pill(gui, name, position)
	local frame = Instance.new("Frame")
	frame.Name = name
	frame.AnchorPoint = Vector2.new(0.5, 0)
	frame.Size = BANNER_SIZE
	frame.Position = position
	frame.BackgroundColor3 = BACKGROUND
	frame.BackgroundTransparency = 0.1
	frame.Visible = false
	frame.Parent = gui
	corner(frame, 12)
	stroke(frame)
	return frame
end

local function buildGui()
	local gui = Instance.new("ScreenGui")
	gui.Name = "UpdateDayBanner"
	gui.ResetOnSpawn = false
	gui.IgnoreGuiInset = false
	gui.DisplayOrder = 50
	gui.Parent = player:WaitForChild("PlayerGui")

	local banner = pill(gui, "Banner", BANNER_POSITION)
	local bannerText = label(banner, UDim2.new(1, -52, 1, -12), UDim2.fromOffset(12, 6))
	local close = Instance.new("TextButton")
	close.Size = UDim2.fromOffset(28, 28)
	close.Position = UDim2.new(1, -36, 0.5, -14)
	close.BackgroundTransparency = 1
	close.Text = "X"
	close.Font = FONT
	close.TextColor3 = ACCENT
	close.TextSize = 16
	close.Parent = banner
	close.Activated:Connect(function()
		dismissed = true
		banner.Visible = false
	end)

	local toast = pill(gui, "Toast", TOAST_POSITION)
	toast.Size = UDim2.fromOffset(380, 46)
	local toastText = label(toast, UDim2.new(1, -24, 1, -12), UDim2.fromOffset(12, 6))

	return banner, bannerText, toast, toastText
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

local banner, bannerText, toast, toastText = buildGui()

local function showToast(text)
	toastText.Text = text
	toast.Visible = true
	toast.BackgroundTransparency = 1
	TweenService:Create(toast, TWEEN, { BackgroundTransparency = 0.1 }):Play()
	task.delay(TOAST_SECONDS, function()
		if toastText.Text == text then
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
			bannerText.Text = string.format(COUNTDOWN_TEXT, clock(left))
			visible = true
		elseif left <= 0 and left > -LIVE_MESSAGE_SECONDS then
			bannerText.Text = LIVE_TEXT
			visible = true
		end
	end
	banner.Visible = visible
	task.wait(REFRESH_SECONDS)
end
