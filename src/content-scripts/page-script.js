"use strict";

if (DEBUG) {
	var log = (msg) => browser.runtime.sendMessage({ type: "log", log: msg });
}

// Subset of consts present in background script (avoids having to ask for them).
const consts = {
	PopupOpenBehaviour_Auto: "auto",

	PopupLocation_Selection: "selection",
	PopupLocation_Cursor: "cursor",

	AutoCopyToClipboard_Always: "always",

	ItemHoverBehaviour_Nothing: "nothing",
	ItemHoverBehaviour_Highlight: "highlight",
	ItemHoverBehaviour_HighlightAndMove: "highlight-and-move",
};

let popup = null;
let selection = {};
let mousePositionX = 0;
let mousePositionY = 0;

// be prepared for messages from background (main) script
browser.runtime.onMessage.addListener(onMessageReceived);
browser.storage.onChanged.addListener(onSettingsChanged);

if (DEBUG) { log("content script has started!"); }

requestActivation();

function requestActivation()
{
	// ask the main script to activate this worker
	browser.runtime.sendMessage({ type: "activationRequest" }).then(
		msg => activate(msg.popupLocation, msg.popupOpenBehaviour),	// main script passes a few settings needed for setup
		getErrorHandler("Error sending activation message from worker.")
	);
}

function onMessageReceived(msg, sender, sendResponse)
{
	if (msg.type === "isAlive") {
		sendResponse(true);
	} else if (msg.type === "deactivate") {
		deactivate();
	} else if (msg.type === "showPopup") {
		onSelectionChange(true);
	} else if (msg.type === "copyToClipboard") {
		document.execCommand("copy");
	}
}

function onSettingsChanged(changes, area)
{
	if (area !== "local" || Object.keys(changes).length === 0) {
		return;
	}

	if (DEBUG) { log("onSettingsChanged"); }

	deactivate();
	requestActivation();
}

function getErrorHandler(text)
{
	return error => log(`${text} (${error})`);
}

function activate(popupLocation, popupOpenBehaviour)
{
	// register with events based on user settings

	if (popupLocation === consts.PopupLocation_Cursor) {
		document.addEventListener("mousemove", onMouseUpdate);
		document.addEventListener("mouseenter", onMouseUpdate);
	}

	if (popupOpenBehaviour === consts.PopupOpenBehaviour_Auto) {
		selectionchange.start();
		document.addEventListener("customselectionchange", onSelectionChange);
	}

	if (DEBUG) { log("worker activated"); }
}

function deactivate()
{
	if (popup !== null) {
		// clean page
		document.documentElement.removeChild(popup);
		popup = null;
	}

	// unregister with all events

	document.removeEventListener("mousemove", onMouseUpdate);
	document.removeEventListener("mouseenter", onMouseUpdate);
	document.documentElement.removeEventListener("keypress", hidePopup);
	document.documentElement.removeEventListener("mousedown", hidePopup);
	window.removeEventListener("scroll", hidePopup);
	// other listeners are destroyed along with their popup objects

	document.removeEventListener("customselectionchange", onSelectionChange);
	selectionchange.stop();

	if (DEBUG) { log("worker deactivated"); }
}

function onSelectionChange(force)
{
	if (!saveCurrentSelection()) {
		return;
	}

	browser.storage.local.get().then(
		settings => {
			if (force !== true)
			{
				if (selection.isInEditableField) {
					if (!settings.allowPopupOnEditableFields) {
						return;
					}
				} else if (!settings.allowPopupOnEditableFields) {
					// even if this is not an input field, don't show popup in contentEditable elements, such as Gmail's compose window
					for (let elem = selection.selection.anchorNode; elem !== document; elem = elem.parentNode)
					{
						if (elem.isContentEditable === undefined) {
							continue;	// check parent for value
						} else if (elem.isContentEditable) {
							return;		// quit
						} else {
							break;		// show popup
						}
					}
				}
			}

			if (settings.autoCopyToClipboard === consts.AutoCopyToClipboard_Always) {
				document.execCommand("copy");
			}

			let searchEngines = settings.searchEngines.filter(e => e.isEnabled);

			if (DEBUG) { log("showing popup: " + popup); }

			if (popup === null) {
				createPopup(settings, searchEngines);
			}

			showPopup(settings, searchEngines);
		},
		getErrorHandler("Error getting settings after onSelectionChange."));
}

function saveCurrentSelection()
{
	let elem = document.activeElement;

	selection.isInEditableField = (elem.tagName === "TEXTAREA" || (elem.tagName === "INPUT" && elem.type !== "password"));

	if (selection.isInEditableField) {
		selection.text = elem.value.substring(elem.selectionStart, elem.selectionEnd);
		selection.element = elem;
	} else {
		// get selection, but exit if there's no text selected after all
		let selectionObject = window.getSelection();
		if (selectionObject === null) {
			return false;
		}
		selection.text = selectionObject.toString();
		selection.selection = selectionObject;
	}

	return selection.text.length > 0;
}

function showPopup(settings, searchEngines)
{
	if (popup !== null)
	{
		popup.style.display = "inline-block";
		setPopupPositionAndSize(popup, searchEngines.length, settings);

		if (settings.popupAnimationDuration > 0) {
			popup.animate(cloneInto({ transform: ["scale(0.8)", "scale(1)"] }, window), settings.popupAnimationDuration);
			popup.animate(cloneInto({ opacity: [0, 1] }, window), settings.popupAnimationDuration * 0.5);
		}
	}
}

function hidePopup()
{
	if (popup !== null) {
		popup.style.display = "none";
	}
}

function createPopup(settings, searchEngines)
{
	// create popup parent (will contain all icons)
	popup = document.createElement("swift-selection-search-popup");

	// format popup, resetting all to initial and including values that will be changed later (set those to "initial" explicitly)
	let popupCssText = `
all: initial;
box-sizing: initial !important;
font-size: 0 !important;
position: absolute !important;
z-index: 2147483647 !important;
text-align: center !important;
overflow: hidden !important;
-moz-user-select: none !important;
user-select: none !important;
background-color: ${settings.popupBackgroundColor} !important;
box-shadow: 0px 0px 3px rgba(0,0,0,.5) !important;
border-radius: ${settings.popupBorderRadius}px !important;
direction: ltr !important;
padding: ${settings.popupPaddingY}px ${settings.popupPaddingX}px !important;
width: initial !important;
height: initial !important;
left: initial !important;
top: initial !important;`;

	popup.style.cssText = popupCssText;

	// create all engine icons

	let sizeText = settings.popupItemSize + "px";
	let iconCssText = `
all: initial;
box-sizing: initial !important;
fontSize: 0 !important;
cursor: pointer !important;
pointer-events: auto !important;
height: ${settings.popupItemSize}px !important;
width: ${settings.popupItemSize}px !important;
padding: ${3 + settings.popupItemVerticalPadding}px ${settings.popupItemPadding}px !important`;

	for (let i = 0; i < searchEngines.length; i++)
	{
		let engine = searchEngines[i];

		let iconTitle;
		let iconImgSource;

		if (engine.type === "sss") {
			// icon paths should not be hardcoded here, but getting them from bg script is cumbersome
			if (engine.id === "copyToClipboard") {
				iconTitle = "Copy to clipboard";
				iconImgSource = browser.extension.getURL("res/sss-engine-icons/copy.svg");
			} else if (engine.id === "openAsLink") {
				iconTitle = "Open as link";
				iconImgSource = browser.extension.getURL("res/sss-engine-icons/open-link.svg");
			}
		} else {
			iconTitle = engine.name;
			if (engine.iconUrl.startsWith("data:")) {
				iconImgSource = engine.iconUrl;
			} else {
				let cachedIcon = settings.searchEnginesCache[engine.iconUrl];
				if (cachedIcon) {
					iconImgSource = cachedIcon;
				} else {
					iconImgSource = engine.iconUrl;
				}
			}
		}

		let icon = document.createElement("img");
		icon.setAttribute("src", iconImgSource);
		icon.title = iconTitle;
		icon.style.cssText = iconCssText;

		if (settings.popupItemHoverBehaviour === consts.ItemHoverBehaviour_Highlight || settings.popupItemHoverBehaviour === consts.ItemHoverBehaviour_HighlightAndMove)
		{
			icon.onmouseover = () => {
				icon.style.borderBottom = `2px ${settings.popupHighlightColor} solid`;
				icon.style.borderRadius = "2px";
				if (settings.popupItemHoverBehaviour === consts.ItemHoverBehaviour_Highlight) {
					// remove 2 pixels to counter the added border of 2px
					icon.style.paddingBottom = (3 + settings.popupItemVerticalPadding - 2) + "px";
				} else {
					// remove 2 pixels of top padding to cause icon to move up
					icon.style.paddingTop = (3 + settings.popupItemVerticalPadding - 2) + "px";
				}
			};
			icon.onmouseout = () => {
				let verticalPaddingStr = (3 + settings.popupItemVerticalPadding) + "px";
				icon.style.borderBottom = "";
				icon.style.borderRadius = "";
				icon.style.paddingTop = verticalPaddingStr;
				icon.style.paddingBottom = verticalPaddingStr;
			};
		}

		icon.addEventListener("mouseup", onSearchEngineClick(engine, settings));
		icon.addEventListener("mousedown", function(ev) {
			// prevents focus from changing to icon and breaking copy from input fields
			ev.preventDefault();
		});
		icon.ondragstart = function() { return false; };	// disable dragging popup images

		popup.appendChild(icon);
	}

	// add popup to page
	document.documentElement.appendChild(popup);

	document.documentElement.addEventListener("keypress", hidePopup);
	document.documentElement.addEventListener("mousedown", hidePopup);	// hide popup from a press down anywhere...
	popup.addEventListener("mousedown", e => e.stopPropagation());	// ...except on the popup itself

	if (settings.hidePopupOnPageScroll) {
		window.addEventListener("scroll", hidePopup);
	}
}

function setPopupPositionAndSize(popup, nEngines, settings)
{
	let itemWidth = settings.popupItemSize + settings.popupItemPadding * 2;
	let itemHeight = settings.popupItemSize + (3 + settings.popupItemVerticalPadding) * 2;

	let nPopupIconsPerRow = nEngines;
	if (!settings.useSingleRow && settings.nPopupIconsPerRow < nPopupIconsPerRow) {
		nPopupIconsPerRow = settings.nPopupIconsPerRow > 0 ? settings.nPopupIconsPerRow : 1;
	}
	let width = itemWidth * nPopupIconsPerRow;
	let height = itemHeight * Math.ceil(nEngines / nPopupIconsPerRow);

	let positionLeft;
	let positionTop;

	if (settings.popupLocation === consts.PopupLocation_Selection) {
		let rect;
		if (selection.isInEditableField) {
			rect = selection.element.getBoundingClientRect();
		} else {
			let range = selection.selection.getRangeAt(0); // get the text range
			rect = range.getBoundingClientRect();
		}
		positionLeft = rect.right + window.pageXOffset;
		positionTop = rect.bottom + window.pageYOffset;
	} else if (settings.popupLocation === consts.PopupLocation_Cursor) {
		positionLeft = mousePositionX;
		positionTop = mousePositionY - height - 10;	// 10 is forced padding to avoid popup being too close to cursor
	}

	// center horizontally
	positionLeft -= width / 2;

	let popupOffsetX = settings.popupOffsetX;
	if (settings.negatePopupOffsetX) {
		popupOffsetX = -popupOffsetX;
	}
	let popupOffsetY = settings.popupOffsetY;
	if (settings.negatePopupOffsetY) {
		popupOffsetY = -popupOffsetY;
	}

	positionLeft += popupOffsetX;
	positionTop -= popupOffsetY;	// invert sign because y is 0 at the top

	let pageWidth = document.documentElement.offsetWidth + window.pageXOffset;
	let pageHeight = document.documentElement.scrollHeight;

	// don't leave the page
	if (positionLeft < 5) {
		positionLeft = 5;
	} else if (positionLeft + width + 10 > pageWidth) {
		positionLeft = pageWidth - width - 10;
	}

	if (positionTop < 5) {
		positionTop = 5;
	} else if (positionTop + height + 10 > pageHeight) {
		let newPositionTop = pageHeight - height - 10;
		if (newPositionTop >= 0) {	// just to be sure, since some websites can have pageHeight = 0
			positionTop = pageHeight - height - 10;
		}
	}

	// set values
	popup.style.width = width + "px";
	popup.style.height = height + "px";
	popup.style.left = positionLeft + "px";
	popup.style.top = positionTop + "px";
}

function onMouseUpdate(e)
{
	mousePositionX = e.pageX;
	mousePositionY = e.pageY;
}

function onSearchEngineClick(engineObject, settings)
{
	return function(ev) {
		if (settings.hidePopupOnSearch) {
			hidePopup();
		}

		if (ev.which === 1 || ev.which === 2)
		{
			let message = {
				type: "engineClick",
				selection: selection.text,
				engine: engineObject,
			};

			if (ev.ctrlKey) {
				message.clickType = "ctrlClick";
			} else if (ev.which === 1) {
				message.clickType = "leftClick";
			} else /*if (e.which === 2)*/ {
				message.clickType = "middleClick";
			}

			browser.runtime.sendMessage(message);
		}
	};
}
