package com.onlymatch.automation;

import android.app.Notification;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

public final class CaptureService extends NotificationListenerService {
  @Override public void onNotificationPosted(StatusBarNotification sbn){
    try{
      String pkg=sbn.getPackageName();
      if(!Data.allow(this,pkg))return;
      Notification n=sbn.getNotification();
      if(n==null||(n.flags&Notification.FLAG_GROUP_SUMMARY)!=0)return;
      Bundle b=n.extras;if(b==null)return;
      CharSequence t=b.getCharSequence(Notification.EXTRA_TITLE);
      CharSequence body=b.getCharSequence(Notification.EXTRA_BIG_TEXT);
      if(body==null)body=b.getCharSequence(Notification.EXTRA_TEXT);
      String title=t==null?"Уведомление":t.toString().trim();
      String text=body==null?"":body.toString().trim();
      if(title.isEmpty()&&text.isEmpty())return;
      if(title.length()>200)title=title.substring(0,200);
      if(text.length()>900)text=text.substring(0,900);
      Data.append(this,pkg,title,text,false);
      SyncService.request(this);
    }catch(Exception ignored){}
  }
}
