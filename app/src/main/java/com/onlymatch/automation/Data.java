package com.onlymatch.automation;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.UUID;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import java.util.regex.Pattern;

final class Data {
  static SharedPreferences config(Context c){return c.getSharedPreferences("onlymatch_config",Context.MODE_PRIVATE);}
  private static final String ALIAS="onlymatch-preview-secret-1";
  private static final Pattern PRIVATE=Pattern.compile("(?i)(код подтверждения|код входа|проверочный код|пароль|password|passcode|verification code|security code|login code|one.time.password|\\botp\\b|\\b2fa\\b|никому не сообщайте)");
  static boolean allow(Context c,String pkg){
    if(!config(c).getBoolean("enabled",false)||pkg.equals(c.getPackageName()))return false;
    if(config(c).getBoolean("all",false))return true;
    String raw=config(c).getString("sources","");
    for(String p:raw.split("[,\\s]+"))if(!p.isEmpty()&&p.trim().equalsIgnoreCase(pkg))return true;
    return false;
  }
  static synchronized JSONArray list(Context c){
    try{return new JSONArray(config(c).getString("events","[]"));}catch(Exception e){return new JSONArray();}
  }
  static synchronized void append(Context c,String pkg,String title,String body,boolean demo){
    if(PRIVATE.matcher(title+" "+body).find())return;
    try {
      JSONArray old=list(c), next=new JSONArray();
      for(int i=0;i<Math.min(old.length(),3);i++){
        JSONObject recent=old.optJSONObject(i);
        if(recent!=null&&recent.optString("package").equals(pkg)&&recent.optString("title").equals(title)&&recent.optString("text").equals(body)
          &&System.currentTimeMillis()-recent.optLong("time")<8000)return;
      }
      JSONObject item=new JSONObject();
      item.put("id",UUID.randomUUID().toString());item.put("package",pkg);item.put("title",title);
      item.put("text",body);item.put("time",System.currentTimeMillis());
      item.put("demo",demo);item.put("sent",false);next.put(item);
      for(int i=0;i<Math.min(old.length(),199);i++)next.put(old.get(i));
      config(c).edit().putString("events",next.toString()).apply();
    }catch(Exception ignored){}
  }
  static synchronized void sent(Context c,String id){
    try{
      JSONArray all=list(c);
      for(int i=0;i<all.length();i++){
        JSONObject item=all.optJSONObject(i);
        if(item!=null&&id.equals(item.optString("id")))item.put("sent",true);
      }
      config(c).edit().putString("events",all.toString()).apply();
    }catch(Exception ignored){}
  }
  static synchronized void clear(Context c){config(c).edit().remove("events").apply();}
  private static SecretKey key() throws Exception {
    KeyStore store=KeyStore.getInstance("AndroidKeyStore");store.load(null);
    if(store.containsAlias(ALIAS))return (SecretKey)store.getKey(ALIAS,null);
    KeyGenerator generator=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");
    generator.init(new KeyGenParameterSpec.Builder(ALIAS,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT)
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
    return generator.generateKey();
  }
  static void saveToken(Context c,String token) throws Exception {
    Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,key());
    String value=Base64.encodeToString(cipher.getIV(),Base64.NO_WRAP)+"."+
      Base64.encodeToString(cipher.doFinal(token.getBytes("UTF-8")),Base64.NO_WRAP);
    config(c).edit().putString("secret",value).apply();
  }
  static String token(Context c){
    try{
      String value=config(c).getString("secret","");
      int dot=value.indexOf('.');
      if(dot<0)return "";
      byte[] iv=Base64.decode(value.substring(0,dot),Base64.NO_WRAP);
      byte[] payload=Base64.decode(value.substring(dot+1),Base64.NO_WRAP);
      Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,iv));
      return new String(cipher.doFinal(payload),"UTF-8");
    }catch(Exception ignored){return "";}
  }
}
