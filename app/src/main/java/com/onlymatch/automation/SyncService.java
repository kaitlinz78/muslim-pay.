package com.onlymatch.automation;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class SyncService extends JobService {
  private static final int NOW=421010, REGULAR=421011;
  private final ExecutorService executor=Executors.newSingleThreadExecutor();
  static void request(Context c){
    try{
      JobScheduler scheduler=(JobScheduler)c.getSystemService(Context.JOB_SCHEDULER_SERVICE);
      if(scheduler==null)return;
      JobInfo job=new JobInfo.Builder(NOW,new ComponentName(c,SyncService.class))
        .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setOverrideDeadline(12000).build();
      scheduler.schedule(job);
    }catch(Exception ignored){}
  }
  static void periodic(Context c){
    try{
      JobScheduler scheduler=(JobScheduler)c.getSystemService(Context.JOB_SCHEDULER_SERVICE);
      if(scheduler==null)return;
      JobInfo job=new JobInfo.Builder(REGULAR,new ComponentName(c,SyncService.class))
        .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setPersisted(true)
        .setPeriodic(15*60*1000).build();
      scheduler.schedule(job);
    }catch(Exception ignored){}
  }
  @Override public boolean onStartJob(JobParameters params){
    executor.execute(()->{
      boolean retry=false;
      try{retry=!upload();}catch(Exception e){retry=true;}
      jobFinished(params,retry);
    });return true;
  }
  @Override public boolean onStopJob(JobParameters params){return true;}
  private boolean upload(){
    String url=Data.config(this).getString("url","").trim(),token=Data.token(this);
    if(!url.startsWith("https://")||token.length()<12)return true;
    JSONArray all=Data.list(this);
    for(int i=all.length()-1;i>=0;i--){
      JSONObject e=all.optJSONObject(i);
      if(e==null||e.optBoolean("sent"))continue;
      HttpURLConnection con=null;
      try{
        con=(HttpURLConnection)new URL(url).openConnection();
        con.setRequestMethod("POST");con.setDoOutput(true);
        con.setConnectTimeout(10000);con.setReadTimeout(10000);
        con.setRequestProperty("Content-Type","application/json; charset=utf-8");
        con.setRequestProperty("Authorization","Bearer "+token);
        JSONObject event=new JSONObject();
        event.put("eventId",e.optString("id"));event.put("sourcePackage",e.optString("package"));
        event.put("title",e.optString("title"));event.put("text",e.optString("text"));
        event.put("timestamp",e.optLong("time"));event.put("demo",e.optBoolean("demo"));
        try(OutputStream out=con.getOutputStream()){out.write(event.toString().getBytes("UTF-8"));}
        int status=con.getResponseCode();
        if(status>=200&&status<300)Data.sent(this,e.optString("id"));
        else if(status==401||status==403)return true;
        else return false;
      }catch(Exception err){return false;}
      finally{if(con!=null)con.disconnect();}
    }
    return true;
  }
}
