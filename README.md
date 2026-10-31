# OnlyMatch Automation Android Preview
Separate test branch. Not integrated with production. Android 8+.
Notification access is granted manually in Android settings, and monitoring defaults to off.
You can choose allowed app package names, view local events, generate a demo event,
and configure an HTTPS server endpoint. No automatic bank payment confirmations.
Notifications with likely one-time codes and passwords are ignored. No promise of uninterrupted
24/7 capture; Android can delay or stop background processes.
Endpoint contract: POST JSON {eventId,sourcePackage,title,text,timestamp,demo} with Bearer token.
The server must validate the token and deduplicate eventId before accepting events.
Build with Gradle :app:assembleDebug; debug signed APK is installable for testing.
